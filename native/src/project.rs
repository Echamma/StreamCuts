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
}

impl Media {
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
    #[serde(default)]
    pub framing: Framing,
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
        self.source_in + (t - self.start)
    }
    pub fn contains(&self, t: f64) -> bool {
        t >= self.start && t < self.end()
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
                Track { id: new_id(), kind: TrackKind::Video, name: "Video 1".into(), muted: false, hidden: false, clips: Vec::new() },
                Track { id: new_id(), kind: TrackKind::Audio, name: "Audio 1".into(), muted: false, hidden: false, clips: Vec::new() },
            ],
            captions: Vec::new(),
            titles: Vec::new(),
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
        let track = Track { id: new_id(), kind, name, muted: false, hidden: false, clips: Vec::new() };
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
        let clip = Clip { id: new_id(), media_id: media.id.clone(), start, source_in: 0.0, duration, volume: 1.0, fade_in: 0.0, fade_out: 0.0, framing: Framing::Fit };
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
        self.tracks[track].clips.push(Clip { start, ..clip });
        self.sort_track(track);
        true
    }

    /// Moves a clip's start edge to `start`, keeping its end where it is.
    pub fn trim_start(&mut self, clip_id: &str, start: f64) -> bool {
        let Some(at) = self.find(clip_id) else { return false };
        let clip = self.tracks[at.track].clips[at.index].clone();
        let previous_end = self.tracks[at.track].clips.iter().filter(|c| c.end() <= clip.start + 1e-9 && c.id != clip.id).map(Clip::end).fold(0.0, f64::max);
        let is_still = self.media(&clip.media_id).map(|m| m.kind == MediaKind::Image).unwrap_or(false);
        let earliest = if is_still { previous_end } else { previous_end.max(clip.start - clip.source_in) };
        let start = start.clamp(earliest, clip.end() - MIN_CLIP);
        let delta = start - clip.start;
        let c = &mut self.tracks[at.track].clips[at.index];
        c.start = start;
        c.duration -= delta;
        if !is_still {
            c.source_in += delta;
        }
        true
    }

    /// Moves a clip's end edge to `end`, keeping its start where it is.
    pub fn trim_end(&mut self, clip_id: &str, end: f64) -> bool {
        let Some(at) = self.find(clip_id) else { return false };
        let clip = self.tracks[at.track].clips[at.index].clone();
        let next_start = self.tracks[at.track].clips.iter().filter(|c| c.start >= clip.end() - 1e-9 && c.id != clip.id).map(|c| c.start).fold(f64::INFINITY, f64::min);
        let source_left = self.media(&clip.media_id).map(|m| m.max_length() - clip.source_in).unwrap_or(f64::INFINITY);
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
            source_in: if is_still { clip.source_in } else { clip.source_in + left },
            duration: clip.duration - left,
            fade_in: 0.0,
            ..clip.clone()
        };
        let id = right.id.clone();
        self.tracks[at.track].clips[at.index].duration = left;
        self.tracks[at.track].clips[at.index].fade_out = 0.0;
        self.tracks[at.track].clips.insert(at.index + 1, right);
        Some(id)
    }

    /// Splits every clip under timeline time `t` (when nothing is selected, the split button cuts across all tracks).
    pub fn split_all(&mut self, t: f64) -> Vec<String> {
        let ids: Vec<String> = self.tracks.iter().flat_map(|track| track.clips.iter().filter(|c| c.contains(t)).map(|c| c.id.clone())).collect();
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
            let gone: Vec<(f64, f64)> = track.clips.iter().filter(|c| clip_ids.contains(&c.id)).map(|c| (c.start, c.duration)).collect();
            if gone.is_empty() {
                continue;
            }
            track.clips.retain(|c| !clip_ids.contains(&c.id));
            removed += gone.len();
            for clip in &mut track.clips {
                let shift: f64 = gone.iter().filter(|(start, _)| *start < clip.start).map(|(_, duration)| duration).sum();
                clip.start = (clip.start - shift).max(0.0);
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
    pub fn snap_points(&self, ignore: Option<&str>) -> Vec<f64> {
        let mut points = vec![0.0];
        for clip in self.tracks.iter().flat_map(|t| t.clips.iter()).filter(|c| Some(c.id.as_str()) != ignore) {
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
        Media { id: new_id(), path: PathBuf::from(format!("C:/m/{}.mp4", new_id())), name: "m".into(), kind, duration, width: 1920, height: 1080, has_audio: kind != MediaKind::Image }
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
        let caption = |id: &str, start: f64, end: f64| Caption { id: id.into(), start, end, text: id.into(), words: Vec::new() };
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
