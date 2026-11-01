//! A StreamCuts project: the media it uses and the tracks of clips that place that media in time. Times are seconds.
//! Every edit goes through a method here, so the editor, Canopy hand-offs and tests share one set of rules: clips on a
//! track never overlap, trims stay inside the source media, and every change can be undone.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Still pictures get this long when placed on the timeline.
pub const STILL_SECONDS: f64 = 5.0;
/// The shortest a clip can be trimmed to.
pub const MIN_CLIP: f64 = 0.1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Video,
    Audio,
    Image,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub id: String,
    pub path: PathBuf,
    pub name: String,
    pub kind: MediaKind,
    /// Length of the source; 0 for still pictures.
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub has_audio: bool,
    /// Frames a second of a video; 0 when unknown (projects saved before it was read) or not a video.
    #[serde(default)]
    pub frame_rate: f64,
}

impl Media {
    /// What the web StreamCuts' media info shows: kind, size, frame rate, length, sound, and the file's size.
    pub fn info(&self) -> String {
        let mut parts = vec![match self.kind { MediaKind::Video => "Video", MediaKind::Audio => "Sound", MediaKind::Image => "Picture" }.to_owned()];
        if self.kind != MediaKind::Audio {
            parts.push(format!("{}×{}", self.width, self.height));
        }
        if self.frame_rate > 0.0 {
            parts.push(format!("{} fps", (self.frame_rate * 100.0).round() / 100.0));
        }
        if self.kind != MediaKind::Image {
            let seconds = self.duration.round() as u64;
            parts.push(format!("{}:{:02}:{:02}", seconds / 3600, seconds / 60 % 60, seconds % 60));
        }
        if self.kind == MediaKind::Video {
            parts.push(if self.has_audio { "with sound" } else { "no sound" }.into());
        }
        if let Ok(meta) = std::fs::metadata(&self.path) {
            parts.push(format!("{:.1} MB", meta.len() as f64 / 1_048_576.0));
        }
        parts.join(" · ")
    }
    /// How long a clip of this media can be.
    pub fn max_length(&self) -> f64 {
        if self.kind == MediaKind::Image { f64::INFINITY } else { self.duration }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    Video,
    Audio,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    pub media_id: String,
    /// Where the clip starts on the timeline.
    pub start: f64,
    /// Where in the source media the clip starts.
    pub source_in: f64,
    pub duration: f64,
    #[serde(default = "full_volume")]
    pub volume: f32,
    /// Seconds the clip takes to fade in at its start and out at its end, picture and sound.
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
    /// Crossfade from the preceding clip on this track, using that clip's unused source tail.
    #[serde(default)]
    pub crossfade_in: f64,
    #[serde(default)]
    pub crossfade_from: Option<String>,
    #[serde(default)]
    pub framing: Framing,
    #[serde(default)]
    pub grade: Grade,
    #[serde(default)]
    pub effects: Effects,
    /// How fast the source plays: 2 is twice as fast (the clip covers twice the source in its length).
    #[serde(default = "normal_speed")]
    pub speed: f64,
}

fn normal_speed() -> f64 {
    1.0
}

/// The slowest and fastest a clip can play.
pub const SPEEDS: std::ops::RangeInclusive<f64> = 0.25..=4.0;

/// A clip's color, as FFmpeg's `eq` takes it: brightness from -1 to 1 (0 leaves it), contrast and saturation as
/// multipliers (1 leaves them).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Grade {
    pub brightness: f32,
    pub contrast: f32,
    pub saturation: f32,
}

impl Default for Grade {
    fn default() -> Self {
        Self { brightness: 0.0, contrast: 1.0, saturation: 1.0 }
    }
}

impl Grade {
    pub fn is_neutral(self) -> bool {
        self == Self::default()
    }

    pub fn filter(self) -> Option<String> {
        (!self.is_neutral()).then(|| format!("eq=brightness={:.3}:contrast={:.3}:saturation={:.3}", self.brightness, self.contrast, self.saturation))
    }
}

/// Simple picture effects shared by preview frames, paused stills, and exports.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Effects {
    /// Gaussian blur radius in pixels at the output size.
    pub blur: f32,
    /// Unsharp strength; 0 leaves the picture alone.
    pub sharpen: f32,
    /// A tone curve preset (the web StreamCuts' tone curves); `None` leaves the tones alone.
    #[serde(default)]
    pub look: Option<Look>,
}

/// FFmpeg's `curves` presets, as named looks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Look {
    Lighter,
    Darker,
    MediumContrast,
    StrongContrast,
    Vintage,
    CrossProcess,
    Negative,
}

impl Look {
    pub const ALL: [Look; 7] = [Look::Lighter, Look::Darker, Look::MediumContrast, Look::StrongContrast, Look::Vintage, Look::CrossProcess, Look::Negative];

    pub fn label(self) -> &'static str {
        match self {
            Look::Lighter => "Lighter",
            Look::Darker => "Darker",
            Look::MediumContrast => "More contrast",
            Look::StrongContrast => "Strong contrast",
            Look::Vintage => "Vintage",
            Look::CrossProcess => "Cross process",
            Look::Negative => "Negative",
        }
    }

    fn preset(self) -> &'static str {
        match self {
            Look::Lighter => "lighter",
            Look::Darker => "darker",
            Look::MediumContrast => "medium_contrast",
            Look::StrongContrast => "strong_contrast",
            Look::Vintage => "vintage",
            Look::CrossProcess => "cross_process",
            Look::Negative => "negative",
        }
    }
}

impl Effects {
    pub fn is_neutral(self) -> bool { self.blur == 0.0 && self.sharpen == 0.0 && self.look.is_none() }

    pub fn filter(self) -> String {
        let mut chain = String::new();
        if let Some(look) = self.look { chain.push_str(&format!(",curves=preset={}", look.preset())); }
        if self.blur > 0.0 { chain.push_str(&format!(",gblur=sigma={:.2}", self.blur.clamp(0.0, 20.0))); }
        if self.sharpen > 0.0 { chain.push_str(&format!(",unsharp=5:5:{:.2}", self.sharpen.clamp(0.0, 2.0))); }
        chain
    }
}

/// A marked moment on the timeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Marker {
    pub id: String,
    pub t: f64,
    #[serde(default)]
    pub label: String,
}

impl Project {
    /// Marks `t` (timeline seconds), unless a marker is already within a frame of it. Returns whether one was added.
    pub fn add_marker(&mut self, t: f64, label: &str) -> bool {
        let frame = 1.0 / self.fps.max(1) as f64;
        if t < 0.0 || self.markers.iter().any(|m| (m.t - t).abs() < frame) {
            return false;
        }
        let at = self.markers.partition_point(|m| m.t < t);
        self.markers.insert(at, Marker { id: new_id(), t, label: label.into() });
        true
    }

    /// Marks where a media's scene changes (source seconds) show on the timeline, in every clip that plays them.
    /// Returns how many markers were added.
    pub fn mark_scenes(&mut self, media_id: &str, cuts: &[f64]) -> usize {
        let times: Vec<f64> = self.tracks.iter().flat_map(|t| t.clips.iter()).filter(|c| c.media_id == media_id)
            .flat_map(|c| cuts.iter().filter(|&&s| s > c.source_in && s < c.source_in + c.source_length()).map(move |&s| c.start + (s - c.source_in) / c.speed))
            .collect();
        times.into_iter().filter(|&t| self.add_marker(t, "Scene")).count()
    }

    /// The nearest marker after (or, `back`, before) `t`.
    pub fn next_marker(&self, t: f64, back: bool) -> Option<f64> {
        let frame = 0.5 / self.fps.max(1) as f64;
        if back {
            self.markers.iter().rev().map(|m| m.t).find(|&m| m < t - frame)
        } else {
            self.markers.iter().map(|m| m.t).find(|&m| m > t + frame)
        }
    }
}

/// An export's file type and codecs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExportFormat {
    /// H.264 and AAC: plays anywhere, uploads anywhere.
    #[default]
    Mp4,
    /// ProRes 422 HQ and PCM in a MOV, for further editing.
    Prores,
    /// AV1 (SVT-AV1) and AAC in an MP4: smaller files at the same quality.
    Av1,
    /// Only the mixed sound, as a 48 kHz WAV stem.
    Audio,
}

impl ExportFormat {
    pub const ALL: [ExportFormat; 4] = [ExportFormat::Mp4, ExportFormat::Prores, ExportFormat::Av1, ExportFormat::Audio];

    pub fn label(self) -> &'static str {
        match self {
            ExportFormat::Mp4 => "MP4 (H.264)",
            ExportFormat::Prores => "ProRes (MOV)",
            ExportFormat::Av1 => "AV1 (MP4)",
            ExportFormat::Audio => "Sound only (WAV)",
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            ExportFormat::Mp4 | ExportFormat::Av1 => "mp4",
            ExportFormat::Prores => "mov",
            ExportFormat::Audio => "wav",
        }
    }
}

/// How a clip's picture is shown: where it sits in the frame, and its color. Export, stills and playback all draw it
/// through `filter`, so the preview is what gets exported.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Picture {
    pub framing: Framing,
    pub grade: Grade,
    pub effects: Effects,
}

impl Picture {
    pub fn filter(self, width: u32, height: u32) -> String {
        let color = match self.grade.filter() {
            Some(eq) => format!("{},{eq}", self.framing.filter(width, height)),
            None => self.framing.filter(width, height),
        };
        format!("{color}{}", self.effects.filter())
    }
}

/// How a picture sits in the frame when their shapes differ (16:9 footage in a 9:16 short).
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum Framing {
    /// All of it, with black bars.
    #[default]
    Fit,
    /// Filling the frame, cropped. `x` and `y` pick the part that stays: 0 is the left (top) edge, 1 the right (bottom).
    Fill { x: f32, y: f32 },
}

impl Framing {
    /// The FFmpeg filters that put a picture into a `width`x`height` frame this way.
    pub fn filter(self, width: u32, height: u32) -> String {
        match self {
            Framing::Fit => format!("scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black"),
            Framing::Fill { x, y } => format!(
                "scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height}:(iw-ow)*{:.3}:(ih-oh)*{:.3}",
                x.clamp(0.0, 1.0),
                y.clamp(0.0, 1.0)
            ),
        }
    }
}

fn full_volume() -> f32 {
    1.0
}

impl Clip {
    pub fn end(&self) -> f64 {
        self.start + self.duration
    }
    /// The source time shown at timeline time `t`.
    pub fn source_time(&self, t: f64) -> f64 {
        self.source_in + (t - self.start) * self.speed
    }
    /// How much of the source the clip covers, in source seconds.
    pub fn source_length(&self) -> f64 {
        self.duration * self.speed
    }
    pub fn contains(&self, t: f64) -> bool {
        t >= self.start && t < self.end()
    }
    pub fn picture(&self) -> Picture {
        Picture { framing: self.framing, grade: self.grade, effects: self.effects }
    }
    /// How far faded in the clip is at timeline time `t`: 0 is black (silent), 1 is full.
    pub fn fade_at(&self, t: f64) -> f64 {
        let fade_in = if self.fade_in > 0.0 { (t - self.start) / self.fade_in } else { 1.0 };
        let fade_out = if self.fade_out > 0.0 { (self.end() - t) / self.fade_out } else { 1.0 };
        fade_in.min(fade_out).clamp(0.0, 1.0)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub kind: TrackKind,
    pub name: String,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub hidden: bool,
    /// Locked tracks keep their clips as they are: nothing on them can be picked, moved, trimmed or dropped onto.
    #[serde(default)]
    pub locked: bool,
    pub clips: Vec<Clip>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub version: u32,
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub media: Vec<Media>,
    /// Top to bottom as the timeline shows them: video tracks first (the top one is in front), then audio.
    pub tracks: Vec<Track>,
    /// Captions in timeline time, in order. They stay put when clips move.
    #[serde(default)]
    pub captions: Vec<Caption>,
    /// Text placed on the picture for a while: titles, labels, end cards.
    #[serde(default)]
    pub titles: Vec<Title>,
    /// Moments marked on the timeline, in order: by hand (M) or by scene detection.
    #[serde(default)]
    pub markers: Vec<Marker>,
    /// Exports even out the loudness to what social video expects (-14 LUFS).
    #[serde(default)]
    pub even_loudness: bool,
    /// What Export makes (the web StreamCuts' Deliver page offers the same).
    #[serde(default)]
    pub export_format: ExportFormat,
    /// The gap under captions, as a fraction of the frame's height (shorts often want them higher).
    #[serde(default = "caption_gap")]
    pub caption_bottom: f32,
    #[serde(default)]
    pub saved_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Title {
    pub id: String,
    pub start: f64,
    pub end: f64,
    pub text: String,
    /// Where the middle of the text sits, from the top (0) to the bottom (1) of the frame.
    #[serde(default = "middle")]
    pub y: f32,
    /// Text size as a fraction of the frame's height.
    #[serde(default = "title_size")]
    pub size: f32,
}

fn caption_gap() -> f32 {
    0.08
}

fn middle() -> f32 {
    0.5
}

fn title_size() -> f32 {
    0.09
}

/// A line of captions: shown from `start` to `end` on the timeline, with each word's timing for styles that follow
/// the speech.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Caption {
    pub id: String,
    pub start: f64,
    pub end: f64,
    pub text: String,
    #[serde(default)]
    pub words: Vec<Word>,
    /// The clip whose speech it is; it moves with that clip. Without one, it goes with whatever clip it sits inside.
    #[serde(default)]
    pub clip: Option<String>,
}

impl Caption {
    /// Whether this caption goes with `clip_id`, a clip that covered `from`..`to`.
    fn belongs_to(&self, clip_id: &str, from: f64, to: f64) -> bool {
        match &self.clip {
            Some(clip) => clip == clip_id,
            None => self.start >= from - 1e-6 && self.end <= to + 1e-6,
        }
    }

    fn shift(&mut self, by: f64) {
        self.start += by;
        self.end += by;
        for word in &mut self.words {
            word.start += by;
            word.end += by;
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Word {
    pub text: String,
    pub start: f64,
    pub end: f64,
}

/// A clip found on the timeline, with where it lives.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClipRef {
    pub track: usize,
    pub index: usize,
}

pub fn new_id() -> String {
    canopy_ui::canopy_core::spaces::new_id()
}

impl Project {
    pub fn new(name: &str) -> Self {
        Project {
            version: 1,
            id: new_id(),
            name: name.to_string(),
            width: 1920,
            height: 1080,
            fps: 30,
            media: Vec::new(),
            tracks: vec![
                Track { id: new_id(), kind: TrackKind::Video, name: "Video 1".into(), muted: false, hidden: false, locked: false, clips: Vec::new() },
                Track { id: new_id(), kind: TrackKind::Audio, name: "Audio 1".into(), muted: false, hidden: false, locked: false, clips: Vec::new() },
            ],
            captions: Vec::new(),
            markers: Vec::new(),
            titles: Vec::new(),
            even_loudness: false,
            export_format: ExportFormat::default(),
            caption_bottom: caption_gap(),
            saved_at: 0,
        }
    }

    /// Adds a three-second title in the middle of the frame at `at` and returns its id.
    pub fn add_title(&mut self, at: f64) -> String {
        let title = Title { id: new_id(), start: at, end: at + 3.0, text: "Your title".into(), y: middle(), size: title_size() };
        let id = title.id.clone();
        self.titles.push(title);
        self.titles.sort_by(|a, b| a.start.total_cmp(&b.start));
        id
    }

    pub fn title_mut(&mut self, id: &str) -> Option<&mut Title> {
        self.titles.iter_mut().find(|t| t.id == id)
    }

    /// Whether there is any text to put on the picture.
    pub fn has_text(&self) -> bool {
        !self.captions.is_empty() || !self.titles.is_empty()
    }

    /// Puts new captions for the stretch `from`..`to` of the timeline, replacing the ones there.
    pub fn add_captions(&mut self, from: f64, to: f64, captions: Vec<Caption>) {
        self.captions.retain(|c| c.end <= from || c.start >= to);
        self.captions.extend(captions);
        self.captions.sort_by(|a, b| a.start.total_cmp(&b.start));
    }

    /// The caption showing at timeline time `t`.
    pub fn caption_at(&self, t: f64) -> Option<&Caption> {
        self.captions.iter().find(|c| t >= c.start && t < c.end)
    }

    /// Takes media out of the project, if no clip uses it.
    pub fn remove_media(&mut self, id: &str) -> bool {
        let used = self.tracks.iter().any(|t| t.clips.iter().any(|c| c.media_id == id));
        let before = self.media.len();
        if !used {
            self.media.retain(|m| m.id != id);
        }
        self.media.len() < before
    }

    /// Media the timeline uses whose file isn't where the project says it is.
    pub fn missing_media(&self) -> Vec<&Media> {
        let used: Vec<&str> = self.tracks.iter().flat_map(|t| t.clips.iter().map(|c| c.media_id.as_str())).collect();
        self.media.iter().filter(|m| used.contains(&m.id.as_str()) && !m.path.is_file()).collect()
    }

    pub fn media(&self, id: &str) -> Option<&Media> {
        self.media.iter().find(|m| m.id == id)
    }

    /// The end of the last clip.
    /// Where the last clip or title ends: a title after the clips shows over black (an end card).
    pub fn duration(&self) -> f64 {
        let clips = self.tracks.iter().flat_map(|t| t.clips.iter().map(Clip::end)).fold(0.0, f64::max);
        self.titles.iter().map(|t| t.end).fold(clips, f64::max)
    }

    pub fn find(&self, clip_id: &str) -> Option<ClipRef> {
        self.tracks.iter().enumerate().find_map(|(track, t)| t.clips.iter().position(|c| c.id == clip_id).map(|index| ClipRef { track, index }))
    }

    pub fn clip(&self, clip_id: &str) -> Option<&Clip> {
        self.find(clip_id).map(|r| &self.tracks[r.track].clips[r.index])
    }

    pub fn clip_mut(&mut self, clip_id: &str) -> Option<&mut Clip> {
        self.find(clip_id).map(|r| &mut self.tracks[r.track].clips[r.index])
    }

    /// The most this clip can crossfade from its immediate predecessor without reaching past the old source.
    pub fn crossfade_limit(&self, clip_id: &str) -> f64 {
        let Some(at) = self.find(clip_id) else { return 0.0 };
        if self.tracks[at.track].kind != TrackKind::Video || at.index == 0 { return 0.0; }
        let incoming = &self.tracks[at.track].clips[at.index];
        let outgoing = &self.tracks[at.track].clips[at.index - 1];
        if (outgoing.end() - incoming.start).abs() > 0.002 { return 0.0; }
        let Some(media) = self.media(&outgoing.media_id) else { return 0.0 };
        if media.kind != MediaKind::Video || self.media(&incoming.media_id).is_none_or(|m| m.kind != MediaKind::Video) { return 0.0; }
        let tail = (media.max_length() - outgoing.source_in - outgoing.source_length()) / outgoing.speed;
        tail.max(0.0).min(incoming.duration).min(outgoing.duration).min(3.0)
    }

    pub fn crossfade_before(&self, clip_id: &str) -> Option<(&Clip, f64)> {
        let at = self.find(clip_id)?;
        if at.index == 0 { return None; }
        let incoming = &self.tracks[at.track].clips[at.index];
        let outgoing = &self.tracks[at.track].clips[at.index - 1];
        if incoming.crossfade_from.as_deref() != Some(outgoing.id.as_str()) { return None; }
        let duration = incoming.crossfade_in.min(self.crossfade_limit(clip_id));
        (duration > 0.0).then_some((outgoing, duration))
    }

    pub fn set_crossfade(&mut self, clip_id: &str, seconds: f64) {
        let Some(at) = self.find(clip_id) else { return };
        let duration = seconds.clamp(0.0, self.crossfade_limit(clip_id));
        let from = (duration > 0.0).then(|| self.tracks[at.track].clips[at.index - 1].id.clone());
        let clip = &mut self.tracks[at.track].clips[at.index];
        clip.crossfade_in = duration;
        clip.crossfade_from = from;
    }

    pub fn crossfade_after(&self, clip_id: &str) -> f64 {
        let Some(at) = self.find(clip_id) else { return 0.0 };
        self.tracks[at.track].clips.get(at.index + 1)
            .and_then(|next| self.crossfade_before(&next.id).map(|(_, d)| d))
            .unwrap_or(0.0)
    }

    /// The two clips that should be blended at `t`, if the visible clip is entering with a crossfade.
    pub fn crossfade_at(&self, t: f64) -> Option<(&Clip, &Media, &Clip, &Media, f64)> {
        let (incoming, incoming_media) = self.front_clip(t)?;
        let (outgoing, duration) = self.crossfade_before(&incoming.id)?;
        if t >= incoming.start + duration { return None; }
        let outgoing_media = self.media(&outgoing.media_id)?;
        Some((outgoing, outgoing_media, incoming, incoming_media, (t - incoming.start) / duration))
    }

    /// Adds media, or returns the one already added from the same file.
    pub fn add_media(&mut self, media: Media) -> String {
        if let Some(existing) = self.media.iter().find(|m| m.path == media.path) {
            return existing.id.clone();
        }
        let id = media.id.clone();
        self.media.push(media);
        id
    }

    /// The track kind a medium's clips go on.
    pub fn track_kind_for(kind: MediaKind) -> TrackKind {
        if kind == MediaKind::Audio { TrackKind::Audio } else { TrackKind::Video }
    }

    /// The first track of a kind, adding one if the project has none.
    pub fn track_of_kind(&mut self, kind: TrackKind) -> usize {
        if let Some(index) = self.tracks.iter().position(|t| t.kind == kind) {
            return index;
        }
        self.add_track(kind)
    }

    /// Adds a track: a video track goes above the others (in front), an audio track at the bottom.
    pub fn add_track(&mut self, kind: TrackKind) -> usize {
        let count = self.tracks.iter().filter(|t| t.kind == kind).count();
        let name = match kind {
            TrackKind::Video => format!("Video {}", count + 1),
            TrackKind::Audio => format!("Audio {}", count + 1),
        };
        let track = Track { id: new_id(), kind, name, muted: false, hidden: false, locked: false, clips: Vec::new() };
        match kind {
            TrackKind::Video => {
                self.tracks.insert(0, track);
                0
            }
            TrackKind::Audio => {
                self.tracks.push(track);
                self.tracks.len() - 1
            }
        }
    }

    fn overlaps(track: &Track, start: f64, end: f64, ignore: Option<&str>) -> bool {
        track.clips.iter().any(|c| Some(c.id.as_str()) != ignore && start < c.end() - 1e-9 && end > c.start + 1e-9)
    }

    /// The earliest start at or after `at` where a clip this long fits on the track.
    pub fn free_start(&self, track: usize, at: f64, duration: f64, ignore: Option<&str>) -> f64 {
        let mut start = at.max(0.0);
        let mut clips: Vec<&Clip> = self.tracks[track].clips.iter().filter(|c| Some(c.id.as_str()) != ignore).collect();
        clips.sort_by(|a, b| a.start.total_cmp(&b.start));
        for clip in clips {
            if start + duration <= clip.start + 1e-9 {
                break;
            }
            if start < clip.end() {
                start = start.max(clip.end());
            }
        }
        start
    }

    /// Places a clip of the media on a track at `at` (or the first free spot after it). Returns the clip's id.
    pub fn place(&mut self, media_id: &str, track: Option<usize>, at: f64) -> Option<String> {
        let media = self.media(media_id)?.clone();
        let kind = Self::track_kind_for(media.kind);
        let track = match track {
            Some(t) if self.tracks.get(t).map(|t| t.kind) == Some(kind) => t,
            _ => self.track_of_kind(kind),
        };
        let duration = if media.kind == MediaKind::Image { STILL_SECONDS } else { media.duration.max(MIN_CLIP) };
        let start = self.free_start(track, at, duration, None);
        let clip = Clip { id: new_id(), media_id: media.id.clone(), start, source_in: 0.0, duration, volume: 1.0, fade_in: 0.0, fade_out: 0.0, crossfade_in: 0.0, crossfade_from: None, framing: Framing::Fit, grade: Grade::default(), effects: Effects::default(), speed: 1.0 };
        let id = clip.id.clone();
        self.tracks[track].clips.push(clip);
        self.sort_track(track);
        Some(id)
    }

    fn sort_track(&mut self, track: usize) {
        self.tracks[track].clips.sort_by(|a, b| a.start.total_cmp(&b.start));
    }

    /// Moves a clip to `start` on `track` (same kind). If it would overlap a neighbor it lands against that neighbor's
    /// nearer edge; if there's no room at all it stays put. Returns whether it moved.
    pub fn move_clip(&mut self, clip_id: &str, start: f64, track: usize) -> bool {
        let Some(from) = self.find(clip_id) else { return false };
        if self.tracks.get(track).map(|t| t.kind) != Some(self.tracks[from.track].kind) {
            return false;
        }
        let clip = self.tracks[from.track].clips[from.index].clone();
        let mut start = start.max(0.0);
        if Self::overlaps(&self.tracks[track], start, start + clip.duration, Some(clip_id)) {
            // Try just after and just before whatever is in the way, and take the closer one that fits.
            let after = self.free_start(track, start, clip.duration, Some(clip_id));
            let before = self.tracks[track].clips.iter()
                .filter(|c| c.id != clip_id && c.start < start + clip.duration && c.end() > start)
                .map(|c| c.start - clip.duration)
                .fold(f64::INFINITY, f64::min);
            let fits_before = before >= 0.0 && !Self::overlaps(&self.tracks[track], before, before + clip.duration, Some(clip_id));
            start = if fits_before && (start - before).abs() < (after - start).abs() { before } else { after };
            if Self::overlaps(&self.tracks[track], start, start + clip.duration, Some(clip_id)) {
                return false;
            }
        }
        self.tracks[from.track].clips.remove(from.index);
        self.tracks[track].clips.push(Clip { start, ..clip.clone() });
        self.sort_track(track);
        // The clip's captions go with it.
        let by = start - clip.start;
        if by != 0.0 {
            self.captions.iter_mut().filter(|c| c.belongs_to(&clip.id, clip.start, clip.end())).for_each(|c| c.shift(by));
            self.captions.sort_by(|a, b| a.start.total_cmp(&b.start));
        }
        true
    }

    /// The clip that ends exactly where `clip_id` starts on its track, if any (the two share a cut).
    pub fn left_neighbor(&self, clip_id: &str) -> Option<String> {
        let at = self.find(clip_id)?;
        let clip = &self.tracks[at.track].clips[at.index];
        self.tracks[at.track].clips.iter().find(|c| c.id != clip.id && (c.end() - clip.start).abs() < 1e-6).map(|c| c.id.clone())
    }

    /// The clip that starts exactly where `clip_id` ends on its track, if any.
    pub fn right_neighbor(&self, clip_id: &str) -> Option<String> {
        let at = self.find(clip_id)?;
        let clip = &self.tracks[at.track].clips[at.index];
        self.tracks[at.track].clips.iter().find(|c| c.id != clip.id && (c.start - clip.end()).abs() < 1e-6).map(|c| c.id.clone())
    }

    /// How far a clip could grow, in timeline seconds: its start back into the footage before its in point, and its
    /// end on into the footage after its out point. Pictures have no limit.
    fn source_room(&self, clip: &Clip) -> (f64, f64) {
        match self.media(&clip.media_id) {
            Some(media) if media.kind != MediaKind::Image => {
                (clip.source_in / clip.speed, (media.max_length() - clip.source_in - clip.source_length()) / clip.speed)
            }
            _ => (f64::INFINITY, f64::INFINITY),
        }
    }

    /// Slides a clip to `start`, keeping the footage it plays: the clip touching it before ends where it now starts and
    /// the one touching it after starts where it now ends, each within its source and no shorter than the shortest
    /// clip. A side with a gap instead keeps the clip off the clip beyond it. Returns whether it changed.
    pub fn slide(&mut self, clip_id: &str, start: f64) -> bool {
        let Some(at) = self.find(clip_id) else { return false };
        let clip = self.tracks[at.track].clips[at.index].clone();
        let (left, right) = (self.left_neighbor(clip_id), self.right_neighbor(clip_id));
        let others = || self.tracks[at.track].clips.iter().filter(|c| c.id != clip.id);
        let (mut lo, mut hi) = (-clip.start, f64::INFINITY);
        match left.as_deref().and_then(|id| self.clip(id)) {
            Some(l) => {
                lo = lo.max(MIN_CLIP - l.duration);
                hi = hi.min(self.source_room(l).1);
            }
            None => lo = lo.max(others().filter(|c| c.end() <= clip.start + 1e-9).map(Clip::end).fold(0.0, f64::max) - clip.start),
        }
        match right.as_deref().and_then(|id| self.clip(id)) {
            Some(r) => {
                hi = hi.min(r.duration - MIN_CLIP);
                lo = lo.max(-self.source_room(r).0);
            }
            None => hi = hi.min(others().filter(|c| c.start >= clip.end() - 1e-9).map(|c| c.start).fold(f64::INFINITY, f64::min) - clip.end()),
        }
        let by = (start - clip.start).max(lo).min(hi);
        if by.abs() < 1e-9 {
            return false;
        }
        if let Some(l) = left.as_deref().and_then(|id| self.clip_mut(id)) {
            l.duration += by;
        }
        let right_still = right.as_deref().and_then(|id| self.clip(id)).and_then(|r| self.media(&r.media_id)).is_some_and(|m| m.kind == MediaKind::Image);
        if let Some(r) = right.as_deref().and_then(|id| self.clip_mut(id)) {
            r.start += by;
            r.duration -= by;
            if !right_still {
                r.source_in += by * r.speed;
            }
        }
        self.tracks[at.track].clips[at.index].start += by;
        // The clip's captions go with it.
        self.captions.iter_mut().filter(|c| c.belongs_to(&clip.id, clip.start, clip.end())).for_each(|c| c.shift(by));
        self.captions.sort_by(|a, b| a.start.total_cmp(&b.start));
        true
    }

    /// Rolls the cut between two touching clips to `t`: the first ends there and the second starts there, each
    /// within the footage its source has, and neither shorter than the shortest clip. Returns whether it changed.
    pub fn roll(&mut self, left_id: &str, right_id: &str, t: f64) -> bool {
        let (Some(left), Some(right)) = (self.clip(left_id).cloned(), self.clip(right_id).cloned()) else { return false };
        let Some(right_media) = self.media(&right.media_id).cloned() else { return false };
        // How far each can grow into the other: the first by the footage after its out point, the second by the
        // footage before its in point.
        let (left_room, right_room) = (self.source_room(&left).1, self.source_room(&right).0);
        let cut = right.start;
        let t = t.clamp((left.start + MIN_CLIP).max(cut - right_room), (right.end() - MIN_CLIP).min(cut + left_room));
        if (t - cut).abs() < 1e-9 {
            return false;
        }
        let left_clip = self.clip_mut(left_id).unwrap();
        left_clip.duration = t - left_clip.start;
        let right_clip = self.clip_mut(right_id).unwrap();
        let shift = t - right_clip.start;
        if right_media.kind != MediaKind::Image {
            right_clip.source_in += shift * right_clip.speed;
        }
        right_clip.start = t;
        right_clip.duration -= shift;
        true
    }

    /// Slips a clip: it stays where it is on the timeline and plays a different stretch of its source, from
    /// `source_in` (kept inside the source). Pictures have nothing to slip. Returns whether it changed.
    pub fn slip(&mut self, clip_id: &str, source_in: f64) -> bool {
        let Some(at) = self.find(clip_id) else { return false };
        let clip = &self.tracks[at.track].clips[at.index];
        let Some(media) = self.media(&clip.media_id) else { return false };
        if media.kind == MediaKind::Image {
            return false;
        }
        let latest = (media.max_length() - clip.source_length()).max(0.0);
        let source_in = source_in.clamp(0.0, latest);
        let clip = &mut self.tracks[at.track].clips[at.index];
        if (clip.source_in - source_in).abs() < 1e-9 {
            return false;
        }
        clip.source_in = source_in;
        true
    }

    /// Moves a clip's start edge to `start`, keeping its end where it is.
    pub fn trim_start(&mut self, clip_id: &str, start: f64) -> bool {
        let Some(at) = self.find(clip_id) else { return false };
        let clip = self.tracks[at.track].clips[at.index].clone();
        let previous_end = self.tracks[at.track].clips.iter().filter(|c| c.end() <= clip.start + 1e-9 && c.id != clip.id).map(Clip::end).fold(0.0, f64::max);
        let is_still = self.media(&clip.media_id).map(|m| m.kind == MediaKind::Image).unwrap_or(false);
        let earliest = if is_still { previous_end } else { previous_end.max(clip.start - clip.source_in / clip.speed) };
        let start = start.clamp(earliest, clip.end() - MIN_CLIP);
        let delta = start - clip.start;
        let c = &mut self.tracks[at.track].clips[at.index];
        c.start = start;
        c.duration -= delta;
        if !is_still {
            c.source_in += delta * c.speed;
        }
        true
    }

    /// Changes how fast a clip plays, keeping the stretch of source it shows: it gets shorter when faster and longer
    /// when slower, though never into the next clip on its track (then it shows less of the source).
    pub fn set_speed(&mut self, clip_id: &str, speed: f64) -> bool {
        let Some(at) = self.find(clip_id) else { return false };
        let clip = self.tracks[at.track].clips[at.index].clone();
        let speed = speed.clamp(*SPEEDS.start(), *SPEEDS.end());
        let next_start = self.tracks[at.track].clips.iter().filter(|c| c.start >= clip.end() - 1e-9 && c.id != clip.id).map(|c| c.start).fold(f64::INFINITY, f64::min);
        let c = &mut self.tracks[at.track].clips[at.index];
        c.duration = (clip.source_length() / speed).min(next_start - clip.start).max(MIN_CLIP);
        c.speed = speed;
        c.fade_in = c.fade_in.min(c.duration / 2.0);
        c.fade_out = c.fade_out.min(c.duration / 2.0);
        true
    }

    /// Moves a clip's end edge to `end`, keeping its start where it is.
    pub fn trim_end(&mut self, clip_id: &str, end: f64) -> bool {
        let Some(at) = self.find(clip_id) else { return false };
        let clip = self.tracks[at.track].clips[at.index].clone();
        let next_start = self.tracks[at.track].clips.iter().filter(|c| c.start >= clip.end() - 1e-9 && c.id != clip.id).map(|c| c.start).fold(f64::INFINITY, f64::min);
        let source_left = self.media(&clip.media_id).map(|m| (m.max_length() - clip.source_in) / clip.speed).unwrap_or(f64::INFINITY);
        let latest = next_start.min(clip.start + source_left);
        let end = end.clamp(clip.start + MIN_CLIP, latest);
        self.tracks[at.track].clips[at.index].duration = end - clip.start;
        true
    }

    /// Splits a clip in two at timeline time `t`. Returns the new right-hand clip's id.
    pub fn split(&mut self, clip_id: &str, t: f64) -> Option<String> {
        let at = self.find(clip_id)?;
        let clip = self.tracks[at.track].clips[at.index].clone();
        if t <= clip.start + MIN_CLIP / 2.0 || t >= clip.end() - MIN_CLIP / 2.0 {
            return None;
        }
        let is_still = self.media(&clip.media_id).map(|m| m.kind == MediaKind::Image).unwrap_or(false);
        let left = t - clip.start;
        // The left half keeps the fade in, the right half the fade out.
        let right = Clip {
            id: new_id(),
            start: t,
            source_in: if is_still { clip.source_in } else { clip.source_in + left * clip.speed },
            duration: clip.duration - left,
            fade_in: 0.0,
            crossfade_in: 0.0,
            crossfade_from: None,
            ..clip.clone()
        };
        let id = right.id.clone();
        self.tracks[at.track].clips[at.index].duration = left;
        self.tracks[at.track].clips[at.index].fade_out = 0.0;
        // Captions of the right half's speech now belong to the right half.
        for caption in self.captions.iter_mut().filter(|c| c.clip.as_deref() == Some(clip.id.as_str()) && c.start >= t - 1e-6) {
            caption.clip = Some(id.clone());
        }
        self.tracks[at.track].clips.insert(at.index + 1, right);
        Some(id)
    }

    /// Splits every clip under timeline time `t` (when nothing is selected, the split button cuts across all tracks).
    pub fn split_all(&mut self, t: f64) -> Vec<String> {
        let ids: Vec<String> = self.tracks.iter().filter(|track| !track.locked)
            .flat_map(|track| track.clips.iter().filter(|c| c.contains(t)).map(|c| c.id.clone())).collect();
        ids.iter().filter_map(|id| self.split(id, t)).collect()
    }

    /// Deletes clips and captions by id.
    pub fn delete(&mut self, clip_ids: &[String]) -> usize {
        let text = self.captions.len() + self.titles.len();
        self.captions.retain(|c| !clip_ids.contains(&c.id));
        self.titles.retain(|t| !clip_ids.contains(&t.id));
        let mut removed = text - self.captions.len() - self.titles.len();
        for track in &mut self.tracks {
            let before = track.clips.len();
            track.clips.retain(|c| !clip_ids.contains(&c.id));
            removed += before - track.clips.len();
        }
        removed
    }

    /// Deletes clips and closes the gaps they leave: later clips on the same track move left by what was deleted.
    pub fn ripple_delete(&mut self, clip_ids: &[String]) -> usize {
        let mut removed = 0;
        for track in &mut self.tracks {
            let gone: Vec<(String, f64, f64)> = track.clips.iter().filter(|c| clip_ids.contains(&c.id)).map(|c| (c.id.clone(), c.start, c.duration)).collect();
            if gone.is_empty() {
                continue;
            }
            track.clips.retain(|c| !clip_ids.contains(&c.id));
            removed += gone.len();
            // Captions of what's left move with their clips: those of a clip that moves by `shift` move by it too.
            let mut moves = Vec::new();
            for clip in &mut track.clips {
                let shift: f64 = gone.iter().filter(|(_, start, _)| *start < clip.start).map(|(_, _, duration)| duration).sum();
                let start = (clip.start - shift).max(0.0);
                moves.push((clip.id.clone(), clip.start, clip.end(), start - clip.start));
                clip.start = start;
            }
            // The deleted clips' own captions go with them.
            self.captions.retain(|c| !gone.iter().any(|(id, start, duration)| c.belongs_to(id, *start, start + duration)));
            for (id, from, to, by) in moves.into_iter().filter(|m| m.3 != 0.0) {
                self.captions.iter_mut().filter(|c| c.belongs_to(&id, from, to)).for_each(|c| c.shift(by));
            }
        }
        removed
    }

    /// The clip in front at time `t`: the topmost visible video track with a clip there.
    pub fn front_clip(&self, t: f64) -> Option<(&Clip, &Media)> {
        self.tracks.iter()
            .filter(|track| track.kind == TrackKind::Video && !track.hidden)
            .find_map(|track| track.clips.iter().find(|c| c.contains(t)))
            .and_then(|clip| self.media(&clip.media_id).map(|m| (clip, m)))
    }

    /// Every clip that makes sound, with its track muted state taken into account.
    pub fn audible_clips(&self) -> Vec<(&Clip, &Media)> {
        self.tracks.iter()
            .filter(|track| !track.muted && !(track.kind == TrackKind::Video && track.hidden))
            .flat_map(|track| track.clips.iter())
            .filter_map(|clip| self.media(&clip.media_id).map(|m| (clip, m)))
            .filter(|(clip, media)| media.has_audio && clip.volume > 0.0)
            .collect()
    }

    /// Clip edges and the playhead, for snapping.
    pub fn snap_points(&self, ignore: &[&str]) -> Vec<f64> {
        let mut points = vec![0.0];
        for clip in self.tracks.iter().flat_map(|t| t.clips.iter()).filter(|c| !ignore.contains(&c.id.as_str())) {
            points.push(clip.start);
            points.push(clip.end());
        }
        points
    }
}

/// Undo and redo as whole-project snapshots: projects are small, and this can't drift out of step with the edits.
#[derive(Default)]
pub struct History {
    undo: Vec<Project>,
    redo: Vec<Project>,
}

impl History {
    /// Call before changing the project.
    pub fn record(&mut self, before: &Project) {
        if self.undo.last() == Some(before) {
            return;
        }
        self.undo.push(before.clone());
        if self.undo.len() > 200 {
            self.undo.remove(0);
        }
        self.redo.clear();
    }
    pub fn undo(&mut self, current: &mut Project) -> bool {
        match self.undo.pop() {
            Some(previous) => {
                self.redo.push(std::mem::replace(current, previous));
                true
            }
            None => false,
        }
    }
    pub fn redo(&mut self, current: &mut Project) -> bool {
        match self.redo.pop() {
            Some(next) => {
                self.undo.push(std::mem::replace(current, next));
                true
            }
            None => false,
        }
    }
    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
    }
    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn media(kind: MediaKind, duration: f64) -> Media {
        Media { id: new_id(), path: PathBuf::from(format!("C:/m/{}.mp4", new_id())), name: "m".into(), kind, duration, width: 1920, height: 1080, has_audio: kind != MediaKind::Image, frame_rate: 30.0 }
    }

    fn project_with(duration: f64) -> (Project, String) {
        let mut project = Project::new("Test");
        let id = project.add_media(media(MediaKind::Video, duration));
        (project, id)
    }

    #[test]
    fn placing_puts_clips_on_the_right_kind_of_track_without_overlap() {
        let (mut project, video) = project_with(10.0);
        let audio = project.add_media(media(MediaKind::Audio, 4.0));
        let first = project.place(&video, None, 0.0).unwrap();
        let second = project.place(&video, None, 5.0).unwrap();
        assert_eq!(project.clip(&second).unwrap().start, 10.0, "a clip placed over another moves after it");
        let sound = project.place(&audio, Some(0), 2.0).unwrap();
        let at = project.find(&sound).unwrap();
        assert_eq!(project.tracks[at.track].kind, TrackKind::Audio, "audio never lands on a video track");
        assert_eq!(project.find(&first).unwrap().track, project.find(&second).unwrap().track);
        assert_eq!(project.duration(), 20.0);
    }

    #[test]
    fn the_same_file_is_added_once() {
        let mut project = Project::new("Test");
        let m = media(MediaKind::Video, 3.0);
        let first = project.add_media(m.clone());
        let second = project.add_media(Media { id: new_id(), ..m });
        assert_eq!(first, second);
        assert_eq!(project.media.len(), 1);
    }

    #[test]
    fn stills_get_five_seconds_and_can_be_stretched() {
        let mut project = Project::new("Test");
        let still = project.add_media(media(MediaKind::Image, 0.0));
        let clip = project.place(&still, None, 1.0).unwrap();
        assert_eq!(project.clip(&clip).unwrap().duration, STILL_SECONDS);
        assert!(project.trim_end(&clip, 30.0));
        assert_eq!(project.clip(&clip).unwrap().end(), 30.0);
        assert!(project.trim_start(&clip, 0.0));
        assert_eq!(project.clip(&clip).unwrap().start, 0.0);
        assert_eq!(project.clip(&clip).unwrap().source_in, 0.0);
    }

    #[test]
    fn crossfade_uses_the_previous_clips_unused_source_tail() {
        let mut project = Project::new("Crossfade");
        let first = project.add_media(media(MediaKind::Video, 10.0));
        let second = project.add_media(media(MediaKind::Video, 10.0));
        let outgoing = project.place(&first, None, 0.0).unwrap();
        project.trim_end(&outgoing, 8.0);
        let incoming = project.place(&second, None, 8.0).unwrap();
        assert_eq!(project.crossfade_limit(&incoming), 2.0);
        project.set_crossfade(&incoming, 1.0);
        let (old, _, new, _, progress) = project.crossfade_at(8.5).unwrap();
        assert_eq!((old.id.as_str(), new.id.as_str()), (outgoing.as_str(), incoming.as_str()));
        assert!((progress - 0.5).abs() < 1e-9);
        assert_eq!(project.crossfade_after(&outgoing), 1.0);
        assert!(project.crossfade_at(9.0).is_none());
        project.clip_mut(&outgoing).unwrap().source_in = 2.0;
        assert_eq!(project.crossfade_after(&outgoing), 0.0, "no source handle means no transition");
    }

    #[test]
    fn sliding_moves_a_clip_between_its_neighbors() {
        let (mut project, video) = project_with(10.0);
        let a = project.place(&video, None, 0.0).unwrap();
        project.trim_end(&a, 3.0); // 0..3, source 0..3
        let b = project.place(&video, None, 3.0).unwrap();
        project.trim_end(&b, 5.0); // 3..5, source 0..2
        let c = project.place(&video, None, 5.0).unwrap();
        project.trim_start(&c, 7.0);
        project.move_clip(&c, 5.0, project.find(&c).unwrap().track); // 5..13, source 2..10
        assert_eq!((project.left_neighbor(&b), project.right_neighbor(&b)), (Some(a.clone()), Some(c.clone())));
        assert!(project.slide(&b, 4.0));
        let at = |p: &Project, id: &str| { let clip = p.clip(id).unwrap(); (clip.start, clip.end(), clip.source_in) };
        assert_eq!((at(&project, &a), at(&project, &b), at(&project, &c)), ((0.0, 4.0, 0.0), (4.0, 6.0, 0.0), (6.0, 13.0, 3.0)));
        // Back towards the start: c has only 3 s of footage before its in point.
        project.slide(&b, 0.0);
        assert_eq!((at(&project, &a), at(&project, &b), at(&project, &c)), ((0.0, 1.0, 0.0), (1.0, 3.0, 0.0), (3.0, 13.0, 0.0)));
    }

    #[test]
    fn rolling_moves_the_cut_within_both_sources() {
        let (mut project, video) = project_with(10.0);
        let a = project.place(&video, None, 0.0).unwrap();
        project.trim_end(&a, 4.0); // source 0..4
        let b = project.place(&video, None, 4.0).unwrap();
        project.trim_start(&b, 6.0); // at 6, source 2..10
        project.move_clip(&b, 4.0, project.find(&b).unwrap().track); // touching at 4, source 2..10 (ends at 12)
        assert_eq!(project.left_neighbor(&b), Some(a.clone()));
        assert!(project.roll(&a, &b, 5.0));
        let (ca, cb) = (project.clip(&a).unwrap().clone(), project.clip(&b).unwrap().clone());
        assert_eq!((ca.duration, cb.start, cb.source_in, cb.end()), (5.0, 5.0, 3.0, 12.0));
        project.roll(&a, &b, 0.0);
        assert_eq!(project.clip(&b).unwrap().start, 2.0, "b can only reach back to its source's start (in point 0)");
        assert_eq!(project.clip(&a).unwrap().end(), 2.0);
    }

    #[test]
    fn slipping_changes_the_source_not_the_place() {
        let (mut project, video) = project_with(10.0);
        let clip = project.place(&video, None, 2.0).unwrap();
        project.trim_end(&clip, 6.0); // plays source 0..4 at 2..6
        assert!(project.slip(&clip, 3.0));
        let slipped = project.clip(&clip).unwrap();
        assert_eq!((slipped.start, slipped.duration, slipped.source_in), (2.0, 4.0, 3.0));
        project.slip(&clip, 9.0);
        assert_eq!(project.clip(&clip).unwrap().source_in, 6.0, "the source ends at 10");
        project.slip(&clip, -2.0);
        assert_eq!(project.clip(&clip).unwrap().source_in, 0.0);
    }

    #[test]
    fn markers_stay_in_order_and_apart() {
        let (mut project, _) = project_with(10.0);
        assert!(project.add_marker(5.0, ""));
        assert!(project.add_marker(2.0, "scene"));
        assert!(!project.add_marker(5.01, ""), "within a frame of another");
        assert_eq!(project.markers.iter().map(|m| m.t).collect::<Vec<_>>(), vec![2.0, 5.0]);
        assert_eq!((project.next_marker(2.0, false), project.next_marker(5.0, true), project.next_marker(6.0, false)), (Some(5.0), Some(2.0), None));
    }

    #[test]
    fn scene_cuts_become_markers_where_clips_play_them() {
        let (mut project, video) = project_with(10.0);
        let clip = project.place(&video, None, 2.0).unwrap();
        project.trim_start(&clip, 3.0); // plays source 1..10 from timeline 3
        assert_eq!(project.mark_scenes(&video, &[0.5, 4.0, 9.0]), 2, "0.5 s is trimmed off");
        assert_eq!(project.markers.iter().map(|m| m.t).collect::<Vec<_>>(), vec![6.0, 11.0]);
        assert_eq!(project.mark_scenes(&video, &[4.0]), 0, "already marked");
    }

    #[test]
    fn locked_tracks_keep_their_clips_whole() {
        let (mut project, video) = project_with(10.0);
        let clip = project.place(&video, None, 0.0).unwrap();
        let at = project.find(&clip).unwrap().track;
        project.tracks[at].locked = true;
        assert!(project.split_all(5.0).is_empty());
        project.tracks[at].locked = false;
        assert_eq!(project.split_all(5.0).len(), 1);
        let json = serde_json::to_string(&project).unwrap();
        assert!(json.contains("\"locked\":false"));
    }

    #[test]
    fn split_makes_two_clips_that_play_the_same_source() {
        let (mut project, video) = project_with(10.0);
        let clip = project.place(&video, None, 2.0).unwrap();
        let right = project.split(&clip, 5.0).unwrap();
        let (l, r) = (project.clip(&clip).unwrap().clone(), project.clip(&right).unwrap().clone());
        assert_eq!((l.start, l.duration, l.source_in), (2.0, 3.0, 0.0));
        assert_eq!((r.start, r.duration, r.source_in), (5.0, 7.0, 3.0));
        assert_eq!(project.split(&clip, 2.01), None, "no slivers at the edges");
        assert_eq!(project.split_all(8.0).len(), 1);
    }

    #[test]
    fn ripple_delete_closes_the_gap_on_that_track_only() {
        let (mut project, video) = project_with(10.0);
        let a = project.place(&video, None, 0.0).unwrap();
        let b = project.place(&video, None, 10.0).unwrap();
        let c = project.place(&video, None, 25.0).unwrap();
        let other = project.add_track(TrackKind::Video);
        let d = project.place(&video, Some(other), 30.0).unwrap();
        assert_eq!(project.ripple_delete(&[b.clone()]), 1);
        assert!(project.clip(&b).is_none());
        let starts: Vec<f64> = [&a, &c, &d].iter().map(|id| project.clip(id).unwrap().start).collect();
        assert_eq!(starts, vec![0.0, 15.0, 30.0], "c moves left by b's length; the other track stays");
    }

    #[test]
    fn new_captions_replace_the_ones_in_their_stretch() {
        let (mut project, _) = project_with(10.0);
        let caption = |id: &str, start: f64, end: f64| Caption { id: id.into(), start, end, text: id.into(), words: Vec::new(), clip: None };
        project.add_captions(0.0, 30.0, vec![caption("a", 1.0, 2.0), caption("b", 12.0, 14.0), caption("c", 25.0, 27.0)]);
        project.add_captions(10.0, 20.0, vec![caption("d", 11.0, 13.0)]);
        let ids: Vec<&str> = project.captions.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "d", "c"]);
        assert_eq!(project.caption_at(12.5).map(|c| c.id.as_str()), Some("d"));
        assert_eq!(project.caption_at(5.0), None);
        assert_eq!(project.delete(&["d".to_string()]), 1);
        assert_eq!(project.captions.len(), 2);
    }

    #[test]
    fn titles_last_three_seconds_and_can_make_an_end_card() {
        let (mut project, video) = project_with(10.0);
        project.place(&video, None, 0.0).unwrap();
        let id = project.add_title(9.0);
        assert_eq!(project.duration(), 12.0, "a title past the clips makes the cut longer");
        assert!(project.has_text());
        assert_eq!(project.delete(&[id]), 1);
        assert_eq!(project.duration(), 10.0);
    }

    #[test]
    fn speed_keeps_the_source_and_respects_the_next_clip() {
        let (mut project, video) = project_with(10.0);
        let a = project.place(&video, None, 0.0).unwrap();
        let b = project.place(&video, None, 12.0).unwrap();
        assert!(project.set_speed(&a, 2.0));
        let clip = project.clip(&a).unwrap().clone();
        assert_eq!((clip.duration, clip.source_time(2.0)), (5.0, 4.0));
        assert!(project.set_speed(&a, 0.5));
        assert_eq!(project.clip(&a).unwrap().duration, 12.0, "slower would run into b at 12 s: it stops there");
        // Splitting and trimming a fast clip move the source by twice the timeline.
        project.set_speed(&b, 2.0);
        let right = project.split(&b, 13.0).unwrap();
        assert_eq!(project.clip(&right).unwrap().source_in, 2.0);
        project.trim_start(&right, 13.5);
        assert_eq!(project.clip(&right).unwrap().source_in, 3.0);
    }

    #[test]
    fn only_unused_media_can_be_removed() {
        let (mut project, video) = project_with(10.0);
        let spare = project.add_media(media(MediaKind::Audio, 5.0));
        project.place(&video, None, 0.0).unwrap();
        assert!(!project.remove_media(&video), "a clip uses it");
        assert!(project.remove_media(&spare));
        assert_eq!(project.media.len(), 1);
    }

    #[test]
    fn missing_media_is_only_what_the_timeline_uses() {
        let (mut project, video) = project_with(10.0);
        let unused = project.add_media(media(MediaKind::Video, 5.0));
        assert!(project.missing_media().is_empty(), "nothing on the timeline yet");
        project.place(&video, None, 0.0).unwrap();
        let missing: Vec<&str> = project.missing_media().iter().map(|m| m.id.as_str()).collect();
        assert_eq!(missing, vec![video.as_str()], "C:/m/... doesn't exist; the unused {unused} doesn't count");
    }

    #[test]
    fn captions_go_with_their_clip() {
        let (mut project, video) = project_with(10.0);
        let a = project.place(&video, None, 0.0).unwrap();
        let b = project.place(&video, None, 10.0).unwrap();
        let caption = |id: &str, start: f64, end: f64, clip: Option<&String>| Caption { id: id.into(), start, end, text: id.into(), words: vec![Word { text: id.into(), start, end }], clip: clip.cloned() };
        // a's caption knows its clip; b's is from an older project and goes by where it sits.
        project.add_captions(0.0, 20.0, vec![caption("in a", 1.0, 2.0, Some(&a)), caption("in b", 12.0, 13.0, None)]);
        // A clip on another track over the same time doesn't take a's caption with it.
        let other = project.add_track(TrackKind::Video);
        let c = project.place(&video, Some(other), 0.0).unwrap();
        project.move_clip(&c, 40.0, other);
        assert_eq!(project.captions[0].start, 1.0);
        let track = project.find(&b).unwrap().track;
        project.move_clip(&b, 30.0, track);
        assert_eq!((project.captions[1].start, project.captions[1].words[0].end), (32.0, 33.0), "b's caption moved with b");
        assert_eq!(project.captions[0].start, 1.0, "a's stayed");
        // Ripple-deleting a takes its caption and pulls b's caption left with b.
        project.ripple_delete(&[a]);
        assert_eq!(project.captions.len(), 1);
        assert_eq!((project.clip(&b).unwrap().start, project.captions[0].start), (20.0, 22.0));
    }

    #[test]
    fn trims_stay_inside_the_source_and_the_neighbors() {
        let (mut project, video) = project_with(10.0);
        let a = project.place(&video, None, 0.0).unwrap();
        let b = project.place(&video, None, 10.0).unwrap();
        assert!(project.trim_start(&b, 12.0));
        let clip = project.clip(&b).unwrap().clone();
        assert_eq!((clip.start, clip.source_in, clip.duration), (12.0, 2.0, 8.0));
        assert!(project.trim_start(&b, 5.0));
        assert_eq!(project.clip(&b).unwrap().start, 10.0, "can't reveal before the source starts or cross clip a");
        assert!(project.trim_end(&a, 15.0));
        assert_eq!(project.clip(&a).unwrap().end(), 10.0, "can't run past the source");
        assert!(project.trim_end(&a, 4.0));
        assert!(project.trim_end(&a, 99.0));
        assert_eq!(project.clip(&a).unwrap().end(), 10.0);
    }

    #[test]
    fn moving_lands_against_neighbors_and_keeps_track_kinds() {
        let (mut project, video) = project_with(4.0);
        let a = project.place(&video, None, 0.0).unwrap();
        let b = project.place(&video, None, 10.0).unwrap();
        let track = project.find(&a).unwrap().track;
        assert!(project.move_clip(&b, 2.0, track));
        assert_eq!(project.clip(&b).unwrap().start, 4.0, "lands right after clip a");
        assert!(project.move_clip(&b, 20.0, track));
        assert_eq!(project.clip(&b).unwrap().start, 20.0);
        let audio_track = project.track_of_kind(TrackKind::Audio);
        assert!(!project.move_clip(&b, 0.0, audio_track), "video stays on video tracks");
        let upper = project.add_track(TrackKind::Video);
        assert!(project.move_clip(&a, 0.0, upper));
        assert_eq!(project.front_clip(1.0).unwrap().0.id, a, "the top video track is in front");
    }

    #[test]
    fn hidden_and_muted_tracks_drop_out() {
        let (mut project, video) = project_with(4.0);
        let clip = project.place(&video, None, 0.0).unwrap();
        assert_eq!(project.audible_clips().len(), 1);
        let track = project.find(&clip).unwrap().track;
        project.tracks[track].muted = true;
        assert!(project.audible_clips().is_empty());
        project.tracks[track].hidden = true;
        assert!(project.front_clip(1.0).is_none());
    }

    #[test]
    fn undo_and_redo_restore_whole_projects() {
        let (mut project, video) = project_with(4.0);
        let mut history = History::default();
        history.record(&project);
        project.place(&video, None, 0.0);
        assert!(history.undo(&mut project));
        assert_eq!(project.duration(), 0.0);
        assert!(history.redo(&mut project));
        assert_eq!(project.duration(), 4.0);
        assert!(!history.redo(&mut project));
    }

    #[test]
    fn projects_round_trip_through_json() {
        let (mut project, video) = project_with(4.0);
        project.place(&video, None, 1.5);
        let json = serde_json::to_string(&project).unwrap();
        assert!(json.contains("\"sourceIn\""));
        let back: Project = serde_json::from_str(&json).unwrap();
        assert_eq!(back, project);
    }
}
