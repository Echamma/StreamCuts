//! The StreamCuts editor: toolbar, media bin, preview with transport, and the timeline. One instance runs per space in
//! Canopy, or alone in StreamCuts' own window.

use crate::audio::Audio;
use crate::boss::Suggestion;
use crate::captions;
use crate::export::{self, Export, Preset, Queued, Status};
use crate::ffmpeg::Frame;
use crate::filmstrip::Strip;
use crate::keys::{self, Cmd};
use crate::preview::{Clock, Preview};
use crate::project::{
    Effects, ExportFormat, Framing, Grade, History, MediaKind, Picture, Placement, Project, Retime,
    SPEEDS, Sound,
};
use crate::storage;
use crate::timeline::{Looks, MediaDrag, Timeline, timecode};
use crate::worker::{Done, Job, Worker};
use canopy_ui::canopy_core::files::Kind;
use canopy_ui::{
    CanopyApp, Host, Icon, Mood, Place, Receipt, SharedFile, color, font, icon, icon_button,
    pane_frame, pill, primary_button, quiet_button,
};
use egui::{
    Align2, Color32, ColorImage, Key, Modifiers, Pos2, Rect, Sense, Stroke, TextureHandle,
    TextureOptions, Ui, UiBuilder, pos2, vec2,
};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

#[path = "codex_panel.rs"]
mod codex_panel;

const BIN_WIDTH: f32 = 250.0;
/// Below this width (half of a split Canopy window) the toolbar folds its text buttons into icons.
const NARROW: f32 = 780.0;
const SHAPES: [(&str, u32, u32); 3] = [
    ("16:9", 1920, 1080),
    ("9:16", 1080, 1920),
    ("1:1", 1080, 1080),
];

/// Where a file being imported goes once it has been probed.
struct Pending {
    at: f64,
    track: Option<usize>,
    /// Dropped on the timeline: it goes in where it was let go, and the clips there make room.
    dropped: bool,
    /// A frame grabbed from this clip: it goes in front of it (see `Project::place_grab`).
    over: Option<String>,
}

struct BossPlan {
    media_id: String,
    suggestions: Vec<Suggestion>,
}

pub struct StreamCuts {
    place: Place,
    project: Project,
    history: History,
    edited_at: Option<Instant>,
    worker: Worker,
    looks: Looks,
    /// Transcriptions still running.
    transcribing: usize,
    /// Codex, the editor: its chat panel and whatever it's working on.
    codex: codex_panel::CodexPanel,
    /// Media whose scenes are being found.
    scene_jobs: Vec<String>,
    /// Media whose editing proxy is being made.
    proxy_jobs: Vec<String>,
    /// Clips whose action is being followed (auto-reframe).
    focus_jobs: Vec<String>,
    boss_plan: Option<BossPlan>,
    /// Typing in a caption: one undo step for the whole edit.
    caption_typing: bool,
    /// The Media search, and whether a file's notes are being typed (one undo step per note).
    media_search: String,
    media_typing: bool,
    /// The file selected in Media: Delete removes it while no clip is selected.
    media_selected: Option<String>,
    /// Clips copied with Ctrl+C or cut with Ctrl+X, with the tracks they were on.
    clipboard: Vec<(usize, crate::project::Clip)>,
    /// Dragging a clip setting: one undo step for the whole drag.
    adjusting: bool,
    /// Media whose waveform and filmstrip have been asked for.
    looks_asked: HashSet<String>,
    pending: HashMap<PathBuf, Pending>,
    preview: Preview,
    /// Previews of the video tracks showing below a placed clip, by track (see `Project::layers_at`).
    under: HashMap<usize, Preview>,
    /// A drag on the picture: what it moves or sizes, and how things were when it began.
    picture_drag: Option<PictureDrag>,
    clock: Clock,
    audio: Audio,
    playhead: f64,
    timeline: Timeline,
    export: Option<Export>,
    /// Renders waiting their turn (the web StreamCuts' render queue), the one rendering now (its id), your saved
    /// presets, and the Deliver window with the name for a new preset.
    queue: Vec<Queued>,
    rendering: Option<String>,
    presets: Vec<Preset>,
    show_deliver: bool,
    preset_name: String,
    show_projects: bool,
    toasts: Vec<String>,
    exported: Vec<PathBuf>,
    /// The Commands window (F1): its search and which row the arrow keys are on.
    palette: Option<Palette>,
    /// Enter asked for the Clip menu: open it, then put the keyboard on its first field.
    open_clip_menu: bool,
    /// A picture clip to send to Folio, once the host is at hand.
    to_folio: Option<String>,
    focus_clip_menu: bool,
    /// Ctrl+F asked for the Media search; Page Up/Down picked a file to bring into view.
    focus_media_search: bool,
    media_scroll_to: Option<String>,
    /// The timeline's width last frame (Z fits the whole timeline into it), and StreamCuts' pane.
    lanes_width: f32,
    pane: Rect,
    /// The Change clip speed window (Ctrl+S).
    speed_dialog: Option<SpeedDialog>,
}

/// What the Change clip speed window is setting, until Change speed applies it.
struct SpeedDialog {
    clip: String,
    speed: f64,
    retime: Retime,
    pitch_shift: bool,
    ripple: bool,
    opened: bool,
}

/// Dims `pane` (StreamCuts' own, not all of Canopy) under a window, taking the clicks meant for what's beneath.
fn dim_pane(ctx: &egui::Context, pane: Rect, id: egui::Id) -> egui::Response {
    egui::Area::new(id)
        .order(egui::Order::Middle)
        .fixed_pos(pane.min)
        .constrain(false)
        .show(ctx, |ui| {
            ui.painter().rect_filled(pane, 10.0, Color32::from_black_alpha(110));
            ui.allocate_response(pane.size(), Sense::click())
        })
        .inner
}

#[derive(Default)]
struct Palette {
    query: String,
    at: usize,
    opened: bool,
}

/// The Clip menu's actions that do more than change a field, for the menu and the keyboard alike.
#[derive(Clone, Copy)]
enum ClipOp {
    /// Make (true) or delete (false) the clip's media's editing proxy.
    Proxy(bool),
    /// Measure (false) or normalize (true) its loudness.
    Loudness(bool),
    Scenes,
    Reframe,
    /// Detach its sound (true) or unlink it (false).
    Link(bool),
    /// Show this many more seconds of footage before (true) or after (false).
    Extend(bool, f64),
    Ungroup,
}

/// Something on the preview that can be moved and sized there.
#[derive(Clone, Debug, PartialEq)]
enum Target {
    Clip(String),
    Title(String),
    /// The captions (all of them move and size together); the id is the one showing.
    Captions(String),
}

impl Target {
    fn id(&self) -> &str {
        match self {
            Target::Clip(id) | Target::Title(id) | Target::Captions(id) => id,
        }
    }
}

/// Where a picture drag took hold: inside (move), a corner (resize) or a clip's edge (crop: 0 left, 1 top, 2 right,
/// 3 bottom).
#[derive(Clone, Copy, Debug, PartialEq)]
enum Grip {
    Move,
    Corner(i8, i8),
    Edge(usize),
}

/// A drag on the picture, with how things were when it began: the pointer, a clip's place, a title's or the captions'
/// x, y and size, and the middle of what was grabbed.
#[derive(Clone)]
struct PictureDrag {
    target: Target,
    grip: Grip,
    start: Pos2,
    place: Placement,
    text: (f32, f32, f32),
    center: Pos2,
}

/// Where a clip's picture goes on the preview `screen` and which part of its frame shows (`Place`).
fn placed(screen: Rect, place: &Placement) -> (Rect, Rect) {
    let [left, top, right, bottom] = place.shown();
    let at = |x: f32, y: f32| {
        pos2(
            screen.left() + x * screen.width(),
            screen.top() + y * screen.height(),
        )
    };
    let [l, t, r, b] = place.crop;
    (
        Rect::from_min_max(at(left, top), at(right, bottom)),
        Rect::from_min_max(pos2(l, t), pos2(1.0 - r, 1.0 - b)),
    )
}

impl StreamCuts {
    pub fn new(place: Place, ctx: &egui::Context) -> Self {
        let _ = std::fs::create_dir_all(&place.projects_dir);
        // Open the most recent project here, or start one.
        let project = storage::list(&place.projects_dir)
            .first()
            .and_then(|doc| storage::load(&place.projects_dir.join(&doc.id)).ok())
            .unwrap_or_else(|| Project::new("Untitled cut"));
        let presets = Preset::load(&place.data_dir);
        let mut app = Self {
            place,
            project,
            history: History::default(),
            edited_at: None,
            worker: Worker::new(ctx.clone()),
            looks: Looks::default(),
            transcribing: 0,
            codex: Default::default(),
            scene_jobs: Vec::new(),
            proxy_jobs: Vec::new(),
            focus_jobs: Vec::new(),
            boss_plan: None,
            caption_typing: false,
            media_search: String::new(),
            media_typing: false,
            media_selected: None,
            clipboard: Vec::new(),
            adjusting: false,
            looks_asked: HashSet::new(),
            pending: HashMap::new(),
            preview: Preview::default(),
            under: HashMap::new(),
            picture_drag: None,
            clock: Clock::default(),
            audio: Audio::default(),
            playhead: 0.0,
            timeline: Timeline::default(),
            export: None,
            queue: Vec::new(),
            rendering: None,
            presets,
            show_deliver: false,
            preset_name: String::new(),
            show_projects: false,
            toasts: Vec::new(),
            exported: Vec::new(),
            palette: None,
            open_clip_menu: false,
            to_folio: None,
            focus_clip_menu: false,
            focus_media_search: false,
            media_scroll_to: None,
            lanes_width: 800.0,
            pane: Rect::NOTHING,
            speed_dialog: None,
        };
        app.request_looks();
        app
    }

    /// Where `path`'s editing proxy lives, in the app's data folder.
    fn proxy_entry(&self, path: &std::path::Path) -> Option<PathBuf> {
        crate::cache::entry(&self.place.data_dir, path, "proxy.mp4")
    }

    fn request_looks(&mut self) {
        for media in self.project.media.iter().filter(|m| m.path.is_file()) {
            if self.looks_asked.insert(media.id.clone()) {
                // A proxy made earlier (it's named after the file, like the other looks).
                if let Some(proxy) = self.proxy_entry(&media.path).filter(|p| p.is_file()) {
                    self.preview.proxies.insert(media.id.clone(), proxy);
                }
                if media.has_audio {
                    self.worker.send(Job::Waveform {
                        media_id: media.id.clone(),
                        path: media.path.clone(),
                        cache: self.place.data_dir.clone(),
                    });
                }
                // GIFs added before StreamCuts animated them were saved as stills: find out whether they loop.
                if media.kind == MediaKind::Image
                    && media.duration == 0.0
                    && crate::ffmpeg::is_gif(&media.path)
                {
                    self.worker.send(Job::Loop {
                        media_id: media.id.clone(),
                        path: media.path.clone(),
                    });
                }
                if media.kind == MediaKind::Video {
                    self.worker.send(Job::Filmstrip {
                        media_id: media.id.clone(),
                        path: media.path.clone(),
                        duration: media.duration,
                        cache: self.place.data_dir.clone(),
                    });
                }
            }
            if !self.looks.thumbnails.contains_key(&media.id) && media.kind != MediaKind::Audio {
                self.worker.send(Job::Thumbnail {
                    media_id: media.id.clone(),
                    path: media.path.clone(),
                    at: (media.duration * 0.1).min(1.0),
                });
            }
        }
    }

    fn edited(&mut self) {
        self.edited_at = Some(Instant::now());
    }

    fn open(&mut self, project: Project) {
        let _ = self.save();
        self.project = project;
        self.history.clear();
        self.timeline = Timeline::default();
        self.playhead = 0.0;
        self.pause();
        self.reset_preview();
        self.request_looks();
    }

    fn import(&mut self, files: Vec<PathBuf>, at: f64, track: Option<usize>, dropped: bool) {
        for path in files {
            self.pending.insert(path.clone(), Pending { at, track, dropped, over: None });
            self.worker.send(Job::Probe(path));
        }
    }

    fn texture(ctx: &egui::Context, name: &str, frame: &Frame) -> TextureHandle {
        ctx.load_texture(
            name,
            ColorImage::from_rgba_unmultiplied(frame.size, &frame.rgba),
            TextureOptions::LINEAR,
        )
    }

    fn drain_worker(&mut self, ctx: &egui::Context) {
        while let Ok(done) = self.worker.done.try_recv() {
            match done {
                Done::Probed(path, result) => {
                    let pending = self.pending.remove(&path);
                    match result {
                        Ok(media) => {
                            self.history.record(&self.project);
                            let id = self.project.add_media(media);
                            if let Some(from) = pending.as_ref().and_then(|p| p.over.clone()) {
                                let at = pending.as_ref().map_or(self.playhead, |p| p.at);
                                match self.project.place_grab(&id, &from, at) {
                                    Some(clip) => {
                                        self.timeline.selection = vec![clip];
                                        self.toasts.push("Frame grabbed: drag it on the picture to move it, a corner to resize, an edge to crop".into());
                                    }
                                    None => self.toasts.push("The frame is in Media: the clip it came from is gone".into()),
                                }
                            } else if let Some(p) = pending {
                                let landed = p
                                    .dropped
                                    .then(|| self.project.place_at(&id, p.track, p.at))
                                    .flatten()
                                    .map(|(clip, _)| clip);
                                if let Some(clip) = landed.or_else(|| self.project.place(&id, p.track, p.at)) {
                                    self.timeline.selection = vec![clip];
                                }
                            }
                            self.request_looks();
                            self.edited();
                        }
                        Err(error) => self.toasts.push(error),
                    }
                }
                Done::Looped(id, Some((length, rate))) => {
                    if let Some(media) = self.project.media.iter_mut().find(|m| m.id == id) {
                        (media.duration, media.frame_rate) = (length, rate);
                        self.edited();
                    }
                }
                Done::Looped(_, None) => {}
                Done::Thumbnail(id, Ok(frame)) => {
                    let texture = Self::texture(ctx, &format!("thumb-{id}"), &frame);
                    self.looks.thumbnails.insert(id, texture);
                }
                Done::Thumbnail(_, Err(_)) => {}
                Done::Still(key, frame) => {
                    for layer in self.under.values_mut() {
                        layer.still_done(ctx, key.clone(), frame.clone());
                    }
                    self.preview.still_done(ctx, key, frame);
                }
                Done::Waveform(id, Ok(wave)) => {
                    self.looks.waveforms.insert(id, Arc::new(wave));
                }
                Done::Filmstrip(id, Ok(film)) => {
                    let strip = Strip::new(ctx, &format!("strip-{id}"), film);
                    self.looks.filmstrips.insert(id, strip);
                }
                Done::Waveform(_, Err(_)) | Done::Filmstrip(_, Err(_)) => {}
                Done::Captions { from, to, result } => {
                    self.transcribing = self.transcribing.saturating_sub(1);
                    match result {
                        Ok(captions) => {
                            let count = captions.len();
                            self.history.record(&self.project);
                            self.project.add_captions(from, to, captions);
                            self.edited();
                            self.toasts.push(if count == 0 {
                                "No speech found for captions".into()
                            } else {
                                format!(
                                    "Added {count} caption{}",
                                    if count == 1 { "" } else { "s" }
                                )
                            });
                        }
                        Err(error) => self.toasts.push(error),
                    }
                }
                Done::Loudness {
                    clip,
                    normalize,
                    result,
                } => match result {
                    Ok(lufs) => {
                        let volume = self.project.clip(&clip).map_or(1.0, |c| c.volume as f64);
                        // The measure is of the source; the clip plays it at its volume.
                        let heard = lufs + 20.0 * volume.max(1e-6).log10();
                        if normalize {
                            // To -14 LUFS, within what the volume slider allows (0-200 %).
                            let target =
                                (volume * 10f64.powf((-14.0 - heard) / 20.0)).clamp(0.0, 2.0);
                            self.history.record(&self.project);
                            if let Some(c) = self.project.clip_mut(&clip) {
                                c.volume = target as f32;
                            }
                            self.edited();
                            self.toasts.push(format!(
                                "Was {heard:.1} LUFS; volume set to {:.0} %",
                                target * 100.0
                            ));
                        } else {
                            self.toasts.push(format!(
                                "This clip plays at {heard:.1} LUFS (social apps play at -14)"
                            ));
                        }
                    }
                    Err(error) => self.toasts.push(error),
                },
                Done::Focus { clip, result } => {
                    self.focus_jobs.retain(|id| id != &clip);
                    match result {
                        Ok(track) => {
                            self.history.record(&self.project);
                            if let Some(c) = self.project.clip_mut(&clip) {
                                if c.framing == Framing::Fit {
                                    c.framing = Framing::Fill { x: 0.5, y: 0.5 };
                                }
                                c.follow = track;
                            }
                            self.edited();
                            self.toasts
                                .push("Reframed: the crop follows the action".into());
                        }
                        Err(error) => self.toasts.push(error),
                    }
                }
                Done::Grabbed { clip, at, output, result } => match result {
                    Ok(()) => {
                        self.pending.insert(output.clone(), Pending { at, track: None, dropped: false, over: Some(clip) });
                        self.worker.send(Job::Probe(output));
                    }
                    Err(error) => self.toasts.push(error),
                },
                Done::Proxy { media_id, result } => {
                    self.proxy_jobs.retain(|id| id != &media_id);
                    match result {
                        Ok(proxy) => {
                            self.preview.proxies.insert(media_id, proxy);
                            self.toasts.push("Proxy ready: playback reads it; paused frames and exports use the original".into());
                        }
                        Err(error) => self.toasts.push(error),
                    }
                }
                Done::Scenes { media_id, result } => {
                    self.scene_jobs.retain(|id| id != &media_id);
                    match result {
                        Ok(cuts) => {
                            self.history.record(&self.project);
                            let marked = self.project.mark_scenes(&media_id, &cuts);
                            if marked > 0 {
                                self.edited();
                            }
                            self.toasts.push(match marked {
                                0 => "No scene changes found in the clips on the timeline".into(),
                                1 => "1 scene change marked".into(),
                                n => format!("{n} scene changes marked"),
                            });
                        }
                        Err(error) => self.toasts.push(error),
                    }
                }
            }
        }
    }

    fn seek(&mut self, t: f64) {
        self.playhead = t.clamp(0.0, self.project.duration().max(0.0));
        if self.clock.playing {
            self.play_from(self.playhead);
        }
    }

    /// Plays from `t`: with sound when there's an output, which then sets the pace; else silently on the wall clock.
    fn play_from(&mut self, t: f64) {
        self.clock.play(t);
        let had_output = self.audio.failed.is_none();
        if !self.audio.play(&self.project, t) && had_output {
            if let Some(error) = &self.audio.failed {
                self.toasts.push(format!("Playing without sound: {error}"));
            }
        }
    }

    fn pause(&mut self) {
        self.clock.pause();
        self.audio.pause();
    }

    fn toggle_play(&mut self) {
        if self.clock.playing {
            self.pause();
        } else {
            if self.playhead >= self.project.duration() - 0.05 {
                self.playhead = 0.0;
            }
            self.play_from(self.playhead);
        }
    }

    fn split(&mut self) {
        self.history.record(&self.project);
        let selected: Vec<String> = self.timeline.selection.clone();
        let made = if selected.is_empty() {
            self.project.split_all(self.playhead).len()
        } else {
            selected
                .iter()
                .filter_map(|id| self.project.split(id, self.playhead))
                .count()
        };
        if made > 0 {
            self.edited();
        }
    }

    /// Deletes the selected clips; `ripple` also closes the gaps they leave.
    fn delete_selection(&mut self, ripple: bool) {
        if self.timeline.selection.is_empty() {
            return;
        }
        self.history.record(&self.project);
        if ripple {
            self.project.ripple_delete(&self.timeline.selection);
        } else {
            self.project.delete(&self.timeline.selection);
        }
        self.timeline.selection.clear();
        self.edited();
    }

    /// Forgets what the previews show, so they fetch it again (after the project's shape or a proxy changes).
    fn reset_preview(&mut self) {
        self.preview.reset();
        self.under.clear();
    }

    /// Takes a file out of the project, with the clips that use it (the file stays on disk; Ctrl+Z brings it back).
    fn remove_media(&mut self, id: &str) {
        let Some(name) = self.project.media(id).map(|m| m.name.clone()) else {
            self.media_selected = None;
            return;
        };
        self.history.record(&self.project);
        let Some(clips) = self.project.remove_media_with_clips(id) else {
            return;
        };
        if self.media_selected.as_deref() == Some(id) {
            self.media_selected = None;
        }
        let project = &self.project;
        self.timeline.selection.retain(|clip| {
            project.clip(clip).is_some()
                || project.captions.iter().any(|c| &c.id == clip)
                || project.titles.iter().any(|t| &t.id == clip)
        });
        self.toasts.push(match clips {
            0 => format!("Removed {name}. Ctrl+Z brings it back."),
            1 => format!("Removed {name} and its clip. Ctrl+Z brings them back."),
            n => format!("Removed {name} and its {n} clips. Ctrl+Z brings them back."),
        });
        self.edited();
    }

    /// Pastes clips at `at` and selects them.
    fn paste(&mut self, clips: Vec<(usize, crate::project::Clip)>, at: f64) {
        if clips.is_empty() {
            return;
        }
        self.history.record(&self.project);
        let made = self.project.paste_clips(&clips, at);
        if made.is_empty() {
            self.toasts.push("The files those clips came from are no longer in Media".into());
            return;
        }
        self.timeline.selection = made;
        self.edited();
    }

    /// The selected clips, or with none selected, the clips under the playhead on tracks that aren't locked.
    fn clips_in_hand(&self) -> Vec<String> {
        if !self.timeline.selection.is_empty() {
            return self.timeline.selection.clone();
        }
        let t = self.playhead;
        self.project.tracks.iter().filter(|track| !track.locked).flat_map(|track| track.clips.iter()).filter(|c| c.start < t && t < c.end()).map(|c| c.id.clone()).collect()
    }

    /// Q and W: cut everything before (or after) the playhead off the clips in hand.
    fn trim_to_playhead(&mut self, start: bool) {
        let clips = self.clips_in_hand();
        if clips.is_empty() {
            return;
        }
        self.history.record(&self.project);
        let t = self.playhead;
        let mut trimmed = false;
        for id in &clips {
            trimmed |= if start { self.project.trim_start(id, t) } else { self.project.trim_end(id, t) };
        }
        if trimmed {
            self.edited();
        }
    }

    /// The keyboard: every key in `keys::COMMANDS`, while StreamCuts has the focus and nothing is being typed in.
    fn shortcuts(&mut self, ui: &Ui, focused: bool) {
        // Not while typing, in the Commands window, or with a menu open (Escape then just closes the menu).
        if !focused || ui.ctx().egui_wants_keyboard_input() || self.palette.is_some() || self.speed_dialog.is_some() || egui::Popup::is_any_open(ui.ctx()) {
            return;
        }
        let ctx = ui.ctx().clone();
        // Several presses can come in one frame (a held key, quick typing): each one runs.
        while let Some(cmd) = ctx.input_mut(keys::pressed) {
            self.run(cmd, &ctx);
        }
    }

    /// The clips picked on the timeline (not titles or captions).
    fn picked_clips(&self) -> Vec<String> {
        self.timeline
            .selection
            .iter()
            .filter(|id| self.project.clip(id).is_some())
            .cloned()
            .collect()
    }

    /// The one clip a Clip-menu command acts on: the picked clip, or the clip under the playhead when none is picked.
    fn one_clip(&mut self) -> Option<String> {
        let picked = self.picked_clips();
        let clip = match picked.as_slice() {
            [one] => Some(one.clone()),
            [] => self.clips_in_hand().into_iter().next(),
            _ => None,
        };
        if clip.is_none() {
            self.toasts.push(if picked.len() > 1 { "Pick just one clip for that".into() } else { "Pick a clip first (C picks the one under the playhead)".into() });
        }
        clip
    }

    /// Changes every picked clip (or the clips under the playhead) in one undo step.
    fn change_clips(&mut self, change: impl Fn(&mut crate::project::Clip, MediaKind)) {
        let ids = self.clips_in_hand();
        if ids.is_empty() {
            self.toasts.push("Pick a clip first (C picks the one under the playhead)".into());
            return;
        }
        let before = self.project.clone();
        for id in &ids {
            let kind = self.project.clip(id).and_then(|c| self.project.media(&c.media_id)).map(|m| m.kind);
            if let (Some(kind), Some(clip)) = (kind, self.project.clip_mut(id)) {
                change(clip, kind);
            }
        }
        if self.project != before {
            self.history.record(&before);
            self.edited();
        }
    }

    /// The track the picked clip is on, or the first video track.
    fn picked_track(&self) -> Option<usize> {
        self.picked_clips()
            .first()
            .and_then(|id| self.project.find(id))
            .map(|r| r.track)
    }

    fn import_dialog(&mut self) {
        if let Some(files) = rfd::FileDialog::new()
            .set_title("Import media")
            .add_filter(
                "Video, pictures and sound",
                &[
                    "mp4", "mov", "mkv", "webm", "avi", "m4v", "png", "jpg", "jpeg", "webp", "gif",
                    "mp3", "wav", "m4a", "aac", "flac", "ogg",
                ],
            )
            .pick_files()
        {
            let at = self.project.duration();
            self.import(files, at, None, false);
        }
    }

    fn set_shape(&mut self, i: usize) {
        if (self.project.width, self.project.height) == (SHAPES[i].1, SHAPES[i].2) {
            return;
        }
        self.history.record(&self.project);
        (_, self.project.width, self.project.height) = SHAPES[i];
        self.reset_preview();
        self.edited();
    }

    /// Moves the picked clips by `by` seconds and `tracks` tracks, all or none: if one can't go (another clip is in
    /// the way, the start of the timeline, a track of another kind), nothing moves.
    fn move_picked(&mut self, by: f64, tracks: i32) {
        let mut ids = self.picked_clips();
        if ids.is_empty() {
            self.toasts.push("Pick the clips to move first".into());
            return;
        }
        // Clips that move along with another picked one (linked or grouped) move once, with it.
        let mut seen = Vec::new();
        ids.retain(|id| {
            if seen.contains(id) {
                return false;
            }
            seen.extend(self.project.partners(id));
            true
        });
        // The ones in front go first, so they make room for the ones behind.
        let start = |p: &Project, id: &String| p.clip(id).map_or(0.0, |c| c.start);
        ids.sort_by(|a, b| start(&self.project, a).total_cmp(&start(&self.project, b)));
        if by > 0.0 || tracks > 0 {
            ids.reverse();
        }
        let before = self.project.clone();
        let mut moved = true;
        for id in &ids {
            let (Some(clip), Some(at)) = (self.project.clip(id), self.project.find(id)) else {
                continue;
            };
            let track = at.track as i32 + tracks;
            let to = clip.start + by;
            if to < -1e-9 || track < 0 || !self.project.move_clip(id, to.max(0.0), track as usize) {
                moved = false;
                break;
            }
        }
        if moved && self.project != before {
            self.history.record(&before);
            self.edited();
        } else {
            self.project = before;
            self.toasts.push(if tracks != 0 { "There's no room on that track".into() } else { "There's no room there".into() });
        }
    }

    /// Picks the clip before or after the last picked one on its track (or, with nothing picked, the clip at or
    /// after the playhead), and brings the playhead to it.
    fn pick_neighbor(&mut self, back: bool, extend: bool) {
        let anchor = self.picked_clips().last().cloned().or_else(|| self.clips_in_hand().into_iter().next());
        let found = match anchor.as_deref().and_then(|id| self.project.find(id).map(|at| (id, at))) {
            Some((id, at)) => {
                let track = &self.project.tracks[at.track];
                let me = self.project.clip(id).map_or(0.0, |c| c.start);
                let mut clips: Vec<&crate::project::Clip> = track.clips.iter().collect();
                clips.sort_by(|a, b| a.start.total_cmp(&b.start));
                if back {
                    clips.iter().rev().find(|c| c.start < me - 1e-9).map(|c| (c.id.clone(), c.start))
                } else {
                    clips.iter().find(|c| c.start > me + 1e-9).map(|c| (c.id.clone(), c.start))
                }
            }
            None => self
                .project
                .tracks
                .iter()
                .filter(|t| !t.locked)
                .flat_map(|t| t.clips.iter())
                .filter(|c| if back { c.start <= self.playhead } else { c.end() > self.playhead })
                .min_by(|a, b| (a.start - self.playhead).abs().total_cmp(&(b.start - self.playhead).abs()))
                .map(|c| (c.id.clone(), c.start)),
        };
        match found {
            Some((id, start)) => {
                if !extend {
                    self.timeline.selection.clear();
                }
                if !self.timeline.selection.contains(&id) {
                    self.timeline.selection.push(id);
                }
                self.media_selected = None;
                self.seek(start);
            }
            None => self.toasts.push(if back { "No clip before it".into() } else { "No clip after it".into() }),
        }
    }

    /// Picks the clip under the playhead on the track above or below the picked clip's.
    fn pick_on_track(&mut self, up: bool) {
        let from = self.picked_track().map_or(if up { self.project.tracks.len() } else { usize::MAX }, |t| t);
        let t = self.playhead;
        let tracks: Vec<usize> = if up {
            (0..from.min(self.project.tracks.len())).rev().collect()
        } else {
            (from.wrapping_add(1)..self.project.tracks.len()).collect()
        };
        let found = tracks.into_iter().find_map(|i| {
            let track = &self.project.tracks[i];
            (!track.locked).then(|| track.clips.iter().find(|c| c.start <= t && t < c.end())).flatten().map(|c| c.id.clone())
        });
        match found {
            Some(id) => {
                self.timeline.selection = vec![id];
                self.media_selected = None;
            }
            None => self.toasts.push(if up { "Nothing above at the playhead".into() } else { "Nothing below at the playhead".into() }),
        }
    }

    /// The files Media shows now (its search applied), in order.
    fn shown_media(&self) -> Vec<String> {
        self.project.media.iter().filter(|m| m.matches(&self.media_search)).map(|m| m.id.clone()).collect()
    }

    fn toggle_track(&mut self, which: &str) {
        let Some(i) = self.picked_track() else {
            self.toasts.push("Pick a clip on that track first".into());
            return;
        };
        self.history.record(&self.project);
        let track = &mut self.project.tracks[i];
        let (on, word) = match which {
            "mute" => {
                track.muted = !track.muted;
                (track.muted, if track.muted { "muted" } else { "unmuted" })
            }
            "hide" => {
                track.hidden = !track.hidden;
                (track.hidden, if track.hidden { "hidden" } else { "shown" })
            }
            _ => {
                track.locked = !track.locked;
                (track.locked, if track.locked { "locked" } else { "unlocked" })
            }
        };
        let name = track.name.clone();
        if which == "lock" && on {
            // A locked track's clips can't stay picked.
            let ids: Vec<String> = self.project.tracks[i].clips.iter().map(|c| c.id.clone()).collect();
            self.timeline.selection.retain(|id| !ids.contains(id));
        }
        self.toasts.push(format!("{name} {word}"));
        self.reset_preview();
        self.edited();
    }

    /// Runs a command: from its key, the Commands window, or a button.
    fn run(&mut self, cmd: Cmd, ctx: &egui::Context) {
        let frame = 1.0 / self.project.fps as f64;
        match cmd {
            Cmd::PlayPause => self.toggle_play(),
            Cmd::Seek(by) => self.seek(self.playhead + by),
            Cmd::Frame(back) => self.seek(self.playhead + if back { -frame } else { frame }),
            Cmd::Cut(back) => {
                if let Some(t) = self.project.next_cut(self.playhead, back) {
                    self.seek(t);
                }
            }
            Cmd::Marker(back) => {
                if let Some(t) = self.project.next_marker(self.playhead, back) {
                    self.seek(t);
                }
            }
            Cmd::Start => self.seek(0.0),
            Cmd::End => self.seek(self.project.duration()),
            Cmd::AddMarker => {
                self.history.record(&self.project);
                if self.project.add_marker(self.playhead, "") {
                    self.edited();
                }
            }
            Cmd::RemoveMarker => {
                let near = self.project.markers.iter().position(|m| (m.t - self.playhead).abs() <= frame * 1.5);
                match near {
                    Some(i) => {
                        self.history.record(&self.project);
                        self.project.markers.remove(i);
                        self.edited();
                    }
                    None => self.toasts.push("No marker at the playhead (Shift+← and Shift+→ go to one)".into()),
                }
            }
            Cmd::Zoom(by) => self.timeline.pps = (self.timeline.pps * by).clamp(2.0, 600.0),
            Cmd::ZoomFit => {
                let length = self.project.duration().max(1.0);
                self.timeline.pps = ((self.lanes_width - 140.0).max(100.0) / length as f32).clamp(2.0, 600.0);
                self.timeline.scroll = 0.0;
            }
            Cmd::SelectAll => {
                self.timeline.selection = self.project.tracks.iter().filter(|track| !track.locked).flat_map(|track| track.clips.iter().map(|c| c.id.clone())).collect();
            }
            Cmd::SelectNone => {
                // Escape closes a window first.
                if self.show_projects || self.show_deliver {
                    (self.show_projects, self.show_deliver) = (false, false);
                } else {
                    self.timeline.selection.clear();
                    self.media_selected = None;
                }
            }
            Cmd::SelectAtPlayhead => match self.clips_in_hand_at_playhead() {
                Some(id) => {
                    self.timeline.selection = vec![id];
                    self.media_selected = None;
                }
                None => self.toasts.push("No clip under the playhead".into()),
            },
            Cmd::SelectNeighbor { back, extend } => self.pick_neighbor(back, extend),
            Cmd::SelectTrack(up) => self.pick_on_track(up),
            Cmd::Split => self.split(),
            Cmd::SplitAll => {
                self.history.record(&self.project);
                if self.project.split_all(self.playhead).is_empty() {
                    self.toasts.push("Nothing to split at the playhead".into());
                } else {
                    self.edited();
                }
            }
            Cmd::TrimToPlayhead(start) => self.trim_to_playhead(start),
            Cmd::Delete => match self.media_selected.clone() {
                // Clips picked on the timeline go first; with none, the file picked in Media.
                Some(id) if self.timeline.selection.is_empty() => self.remove_media(&id),
                _ => self.delete_selection(false),
            },
            Cmd::RippleDelete => self.delete_selection(true),
            Cmd::Copy | Cmd::CutClips => {
                if self.timeline.selection.is_empty() {
                    return;
                }
                let cut = cmd == Cmd::CutClips;
                self.clipboard = self.project.copy_clips(&self.timeline.selection);
                let count = self.clipboard.len();
                if cut {
                    self.delete_selection(false);
                }
                self.toasts.push(format!("{} {count} clip{}. Ctrl+V pastes at the playhead.", if cut { "Cut" } else { "Copied" }, if count == 1 { "" } else { "s" }));
            }
            Cmd::Paste => self.paste(self.clipboard.clone(), self.playhead),
            Cmd::Duplicate => {
                if !self.timeline.selection.is_empty() {
                    let clips = self.project.copy_clips(&self.timeline.selection);
                    if let Some(end) = self.project.end_of(&self.timeline.selection) {
                        self.paste(clips, end);
                    }
                }
            }
            Cmd::Undo => {
                if self.history.undo(&mut self.project) {
                    self.edited();
                }
            }
            Cmd::Redo => {
                if self.history.redo(&mut self.project) {
                    self.edited();
                }
            }
            Cmd::Nudge(by) => self.move_picked(by, 0),
            Cmd::NudgeFrames(n) => self.move_picked(n as f64 * frame, 0),
            Cmd::MoveTrack(up) => self.move_picked(0.0, if up { -1 } else { 1 }),
            Cmd::SlipFrames(n) => {
                if let Some(id) = self.one_clip() {
                    let source_in = self.project.clip(&id).map_or(0.0, |c| c.source_in);
                    let was = self.project.clone();
                    if self.project.slip(&id, (source_in + n as f64 * frame).max(0.0)) {
                        self.history.record(&was);
                        self.edited();
                    } else {
                        self.toasts.push("That's the edge of its video".into());
                    }
                }
            }
            Cmd::AddTitle => {
                self.history.record(&self.project);
                let id = self.project.add_title(self.playhead);
                self.timeline.selection = vec![id];
                self.edited();
            }
            Cmd::MakeCaptions => {
                if self.transcribing == 0 {
                    self.make_captions();
                } else {
                    self.toasts.push("Captions are still being made".into());
                }
            }
            Cmd::ClipMenu => {
                if let Some(id) = self.one_clip() {
                    self.timeline.selection = vec![id];
                    self.open_clip_menu = true;
                }
            }
            Cmd::ChangeSpeed => {
                let Some(id) = self.one_clip() else {
                    return;
                };
                let clip = self.project.clip(&id).cloned().unwrap();
                if self.project.media(&clip.media_id).is_some_and(|m| m.kind == MediaKind::Image) {
                    self.toasts.push("A picture has no speed: change its length by trimming it".into());
                    return;
                }
                self.timeline.selection = vec![id.clone()];
                self.speed_dialog = Some(SpeedDialog {
                    clip: id,
                    speed: clip.speed,
                    retime: clip.retime,
                    pitch_shift: clip.pitch_shift,
                    ripple: true,
                    opened: false,
                });
            }
            Cmd::Fades => {
                let all_faded = self.clips_in_hand().iter().all(|id| self.project.clip(id).is_some_and(|c| c.fade_in > 0.0 && c.fade_out > 0.0));
                self.change_clips(|clip, _| {
                    let fade = if all_faded { 0.0 } else { (clip.duration / 2.0).min(0.5) };
                    (clip.fade_in, clip.fade_out) = (fade, fade);
                });
            }
            Cmd::NoFades => self.change_clips(|clip, _| (clip.fade_in, clip.fade_out) = (0.0, 0.0)),
            Cmd::Speed(speed) => {
                let ids: Vec<String> = self.clips_in_hand().into_iter().filter(|id| self.project.clip(id).and_then(|c| self.project.media(&c.media_id)).is_some_and(|m| m.kind != MediaKind::Image)).collect();
                if ids.is_empty() {
                    self.toasts.push("Pick a video or sound clip first".into());
                    return;
                }
                let before = self.project.clone();
                for id in &ids {
                    self.project.set_speed(id, speed);
                }
                if self.project != before {
                    self.history.record(&before);
                    self.edited();
                }
            }
            Cmd::Volume(by) => {
                self.change_clips(|clip, kind| {
                    if kind != MediaKind::Image {
                        clip.volume = ((clip.volume + by) * 10.0).round().clamp(0.0, 20.0) / 10.0;
                    }
                });
                if let Some(clip) = self.clips_in_hand().first().and_then(|id| self.project.clip(id)) {
                    self.toasts.push(format!("Volume {:.0}%", clip.volume * 100.0));
                }
            }
            Cmd::FitOrFill => self.change_clips(|clip, kind| {
                if kind != MediaKind::Audio {
                    clip.framing = match clip.framing {
                        Framing::Fit => Framing::Fill { x: 0.5, y: 0.5 },
                        _ => Framing::Fit,
                    };
                }
            }),
            Cmd::ResetPlace => self.change_clips(|clip, _| clip.place = Placement::default()),
            Cmd::GrabFrame => self.grab_frame(None, None),
            Cmd::EditInFolio => self.to_folio = Some(self.one_clip().unwrap_or_default()),
            Cmd::ResetColor => self.change_clips(|clip, _| (clip.grade, clip.lut) = (Grade::default(), None)),
            Cmd::ResetEffects => self.change_clips(|clip, _| clip.effects = Effects::default()),
            Cmd::ShowMore { before, seconds } => {
                if let Some(id) = self.one_clip() {
                    self.clip_op(&id, ClipOp::Extend(before, seconds));
                }
            }
            Cmd::Ungroup | Cmd::DetachSound | Cmd::Unlink | Cmd::MeasureLoudness | Cmd::Normalize | Cmd::Proxy | Cmd::DeleteProxy | Cmd::DetectScenes | Cmd::AutoReframe => {
                let op = match cmd {
                    Cmd::Ungroup => ClipOp::Ungroup,
                    Cmd::DetachSound => ClipOp::Link(true),
                    Cmd::Unlink => ClipOp::Link(false),
                    Cmd::MeasureLoudness => ClipOp::Loudness(false),
                    Cmd::Normalize => ClipOp::Loudness(true),
                    Cmd::Proxy => ClipOp::Proxy(true),
                    Cmd::DeleteProxy => ClipOp::Proxy(false),
                    Cmd::DetectScenes => ClipOp::Scenes,
                    _ => ClipOp::Reframe,
                };
                if let Some(id) = self.one_clip() {
                    self.clip_op(&id, op);
                }
            }
            Cmd::AddVideoTrack | Cmd::AddAudioTrack => {
                self.history.record(&self.project);
                let kind = if cmd == Cmd::AddVideoTrack { crate::project::TrackKind::Video } else { crate::project::TrackKind::Audio };
                self.project.add_track(kind);
                self.edited();
            }
            Cmd::MuteTrack => self.toggle_track("mute"),
            Cmd::HideTrack => self.toggle_track("hide"),
            Cmd::LockTrack => self.toggle_track("lock"),
            Cmd::Snap => {
                self.timeline.snap = !self.timeline.snap;
                self.toasts.push(if self.timeline.snap { "Snapping on".into() } else { "Snapping off".into() });
            }
            Cmd::Import => self.import_dialog(),
            Cmd::MediaStep(up) => {
                let shown = self.shown_media();
                if shown.is_empty() {
                    return;
                }
                let at = self.media_selected.as_ref().and_then(|id| shown.iter().position(|m| m == id));
                let next = match (at, up) {
                    (None, _) => 0,
                    (Some(i), true) => i.saturating_sub(1),
                    (Some(i), false) => (i + 1).min(shown.len() - 1),
                };
                self.media_selected = Some(shown[next].clone());
                self.media_scroll_to = Some(shown[next].clone());
                self.timeline.selection.clear();
            }
            Cmd::PlaceMedia => match self.media_selected.clone() {
                Some(id) => {
                    self.history.record(&self.project);
                    if let Some(clip) = self.project.place(&id, None, self.playhead) {
                        self.timeline.selection = vec![clip];
                        self.edited();
                    }
                }
                None => self.toasts.push("Pick a file in Media first (Page Up and Page Down)".into()),
            },
            Cmd::FindMedia => self.focus_media_search = true,
            Cmd::Projects => self.show_projects = !self.show_projects,
            Cmd::NewProject => self.open(Project::new("Untitled cut")),
            Cmd::Export => {
                if self.export.is_none() {
                    self.start_export(ctx);
                } else {
                    self.toasts.push("An export is already running".into());
                }
            }
            Cmd::Queue => self.show_deliver = !self.show_deliver,
            Cmd::Shape(i) => self.set_shape(i),
            Cmd::EvenLoudness => {
                self.history.record(&self.project);
                self.project.even_loudness = !self.project.even_loudness;
                self.toasts.push(if self.project.even_loudness { "Even loudness on: exports play at -14 LUFS".into() } else { "Even loudness off".into() });
                self.edited();
            }
            Cmd::NextFormat => {
                let all = ExportFormat::ALL;
                let at = all.iter().position(|f| *f == self.project.export_format).unwrap_or(0);
                self.history.record(&self.project);
                self.project.export_format = all[(at + 1) % all.len()];
                self.toasts.push(format!("Export makes {}", self.project.export_format.label()));
                self.edited();
            }
            Cmd::Scopes => self.preview.scopes.on = !self.preview.scopes.on,
            Cmd::Boss => self.codex_toggle(),
            Cmd::Commands => self.palette = Some(Palette::default()),
        }
    }

    /// The topmost clip under the playhead on a track that isn't locked.
    fn clips_in_hand_at_playhead(&self) -> Option<String> {
        let t = self.playhead;
        self.project
            .tracks
            .iter()
            .filter(|track| !track.locked)
            .find_map(|track| track.clips.iter().find(|c| c.start <= t && t < c.end()))
            .map(|c| c.id.clone())
    }

    /// The Commands window: every command with its keys, searchable; arrows pick, Enter runs, Escape closes.
    fn commands_window(&mut self, ui: &mut Ui) {
        let Some(palette) = self.palette.as_mut() else {
            return;
        };
        let (up, down, enter, escape) = ui.input_mut(|i| {
            (
                i.consume_key(Modifiers::NONE, Key::ArrowUp),
                i.consume_key(Modifiers::NONE, Key::ArrowDown),
                i.consume_key(Modifiers::NONE, Key::Enter),
                i.consume_key(Modifiers::NONE, Key::Escape),
            )
        });
        let found = keys::search(&palette.query);
        if down {
            palette.at = (palette.at + 1).min(found.len().saturating_sub(1));
        }
        if up {
            palette.at = palette.at.saturating_sub(1);
        }
        palette.at = palette.at.min(found.len().saturating_sub(1));
        let mut chosen = (enter && !found.is_empty()).then(|| found[palette.at].cmd);
        let pane = if self.pane.is_positive() { self.pane } else { ui.ctx().content_rect() };
        let mut close = escape;
        // Dims StreamCuts' pane only: the rest of Canopy stays usable.
        let backdrop = egui::Area::new(ui.scope_id().with("commands-backdrop"))
            .order(egui::Order::Middle)
            .fixed_pos(pane.min)
            .constrain(false)
            .show(ui.ctx(), |ui| {
                ui.painter().rect_filled(pane, 10.0, Color32::from_black_alpha(110));
                ui.allocate_response(pane.size(), Sense::click())
            })
            .inner;
        close |= backdrop.clicked();
        let width = (pane.width() - 40.0).clamp(280.0, 560.0);
        let mut search_id = None;
        egui::Area::new(ui.scope_id().with("commands"))
            .order(egui::Order::Foreground)
            .pivot(Align2::CENTER_TOP)
            .fixed_pos(pos2(pane.center().x, pane.top() + 40.0))
            .show(ui.ctx(), |ui| {
                egui::Frame::popup(ui.style()).show(ui, |ui| {
                    ui.set_width(width);
                    ui.label(egui::RichText::new("Commands").font(font::display(18.0)));
                    let search = ui.add(
                        egui::TextEdit::singleline(&mut palette.query)
                            .hint_text("Type to find a command or a key")
                            .desired_width(f32::INFINITY),
                    );
                    search_id = Some(search.id);
                    if !palette.opened {
                        search.request_focus();
                        palette.opened = true;
                    }
                    if search.changed() {
                        palette.at = 0;
                    }
                    ui.label(canopy_ui::muted("↑ ↓ pick · Enter runs · Esc closes · Tab and Enter work in any menu or window"));
                    ui.add_space(4.0);
                    egui::ScrollArea::vertical().max_height((pane.height() - 160.0).max(160.0)).show(ui, |ui| {
                        let mut group = "";
                        for (i, command) in found.iter().enumerate() {
                            if command.group != group {
                                group = command.group;
                                ui.add_space(4.0);
                                ui.label(egui::RichText::new(group).font(font::ui(12.0)).color(color::INK_MUTED));
                            }
                            let (rect, row) = ui.allocate_exact_size(vec2(ui.available_width(), 26.0), Sense::click());
                            let on = i == palette.at;
                            if on || row.hovered() {
                                ui.painter().rect_filled(rect, 6, if on { color::VEIL_STRONG } else { color::VEIL_HOVER });
                            }
                            if on && (up || down) {
                                row.scroll_to_me(None);
                            }
                            ui.painter().text(pos2(rect.left() + 8.0, rect.center().y), Align2::LEFT_CENTER, command.name, font::ui(14.0), color::INK);
                            ui.painter().text(pos2(rect.right() - 8.0, rect.center().y), Align2::RIGHT_CENTER, keys::keys_label(command), font::ui(12.0), color::INK_SOFT);
                            if row.clicked() {
                                chosen = Some(command.cmd);
                            }
                        }
                        if found.is_empty() {
                            ui.label(canopy_ui::muted("Nothing matches."));
                        }
                    });
                });
            });
        // Closing hands the keyboard back at once, or the next key press would still go to the search box.
        if chosen.is_some() || close {
            if let Some(id) = search_id {
                ui.ctx().memory_mut(|m| m.surrender_focus(id));
            }
        }
        if let Some(cmd) = chosen {
            self.palette = None;
            if cmd != Cmd::Commands {
                let ctx = ui.ctx().clone();
                self.run(cmd, &ctx);
            }
        } else if close {
            self.palette = None;
        }
    }

    /// The Change clip speed window (Ctrl+S), as Resolve's: speed or length, how slow motion fills the project's
    /// frames, the pitch, and whether what comes after moves along. Exports stay at the project's frame rate.
    fn speed_window(&mut self, ui: &mut Ui) {
        let Some(dialog) = self.speed_dialog.as_mut() else {
            return;
        };
        let Some(clip) = self.project.clip(&dialog.clip).cloned() else {
            self.speed_dialog = None;
            return;
        };
        let media = self.project.media(&clip.media_id).cloned();
        let fps = self.project.fps;
        let source_fps = media.as_ref().map(|m| m.frame_rate).filter(|r| *r > 0.0).unwrap_or(fps as f64);
        let has_sound = media.as_ref().is_some_and(|m| m.has_audio);
        let is_video = media.as_ref().is_some_and(|m| m.kind == MediaKind::Video);
        let source = clip.source_length();
        // The room before the next clip on its track, when what comes after stays where it is.
        let room = self
            .project
            .find(&clip.id)
            .map(|at| &self.project.tracks[at.track])
            .and_then(|track| track.clips.iter().filter(|c| c.start >= clip.end() - 1e-9 && c.id != clip.id).map(|c| c.start).reduce(f64::min))
            .map(|next| next - clip.start);
        let pane = if self.pane.is_positive() { self.pane } else { ui.ctx().content_rect() };
        let backdrop = dim_pane(ui.ctx(), pane, ui.scope_id().with("speed-backdrop"));
        let (enter, escape) = ui.input(|i| (i.key_pressed(Key::Enter), i.key_pressed(Key::Escape)));
        let typing = ui.ctx().memory(|m| m.focused().is_some());
        let mut apply = enter && !typing;
        let mut close = escape || backdrop.clicked();
        let mut focused_field = None;
        egui::Area::new(ui.scope_id().with("speed"))
            .order(egui::Order::Foreground)
            .pivot(Align2::CENTER_CENTER)
            .fixed_pos(pane.center())
            .constrain_to(pane.shrink(8.0))
            .show(ui.ctx(), |ui| {
                egui::Frame::popup(ui.style()).show(ui, |ui| {
                    ui.set_width((pane.width() - 40.0).clamp(280.0, 440.0));
                    ui.label(egui::RichText::new("Change clip speed").font(font::display(18.0)));
                    let name = media.as_ref().map_or("Clip", |m| m.name.as_str());
                    ui.label(canopy_ui::muted(&format!("{name} · {source:.2} s of its footage")));
                    ui.add_space(6.0);
                    let mut percent = dialog.speed * 100.0;
                    let mut length = source / dialog.speed;
                    egui::Grid::new("speed-fields").num_columns(2).spacing(vec2(10.0, 8.0)).show(ui, |ui| {
                        ui.label("Speed");
                        let field = ui.add(egui::DragValue::new(&mut percent).range(SPEEDS.start() * 100.0..=SPEEDS.end() * 100.0).speed(1.0).max_decimals(1).suffix(" %"));
                        if !dialog.opened {
                            field.request_focus();
                            dialog.opened = true;
                        }
                        if field.changed() {
                            dialog.speed = percent / 100.0;
                        }
                        // Typed a number and pressed Enter: that's the change.
                        if field.lost_focus() && enter {
                            apply = true;
                        }
                        focused_field = Some(field.id);
                        ui.end_row();
                        ui.label("Length");
                        let field = ui.add(egui::DragValue::new(&mut length).range(source / SPEEDS.end()..=source / SPEEDS.start()).speed(0.02).max_decimals(2).suffix(" s"));
                        if field.changed() && length > 0.0 {
                            dialog.speed = (source / length).clamp(*SPEEDS.start(), *SPEEDS.end());
                        }
                        if field.lost_focus() && enter {
                            apply = true;
                        }
                        ui.end_row();
                    });
                    ui.horizontal_wrapped(|ui| {
                        for preset in [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 4.0] {
                            if ui.selectable_label((dialog.speed - preset).abs() < 1e-6, format!("{}%", preset * 100.0)).clicked() {
                                dialog.speed = preset;
                            }
                        }
                    });
                    ui.add_space(6.0);
                    let speed = dialog.speed;
                    if is_video {
                        let per_second = source_fps * speed;
                        let note = if (speed - 1.0).abs() < 1e-6 {
                            format!("Plays at its own pace. Exports stay at the project's {fps} fps.")
                        } else if per_second >= fps as f64 - 1e-6 {
                            format!("Each second shows {per_second:.0} frames' worth of its {source_fps:.0} fps footage, at the project's {fps} fps: the frames in between are skipped.")
                        } else {
                            format!("Each second has {per_second:.1} of its own frames, and the project's {fps} fps needs {fps}: the rest are made as below.")
                        };
                        ui.label(canopy_ui::muted(&note));
                        let slow = per_second < fps as f64 - 1e-6;
                        ui.add_enabled_ui(slow, |ui| {
                            ui.label(egui::RichText::new("Slow motion").font(font::ui(12.0)).color(color::INK_MUTED));
                            for retime in Retime::ALL {
                                ui.radio_value(&mut dialog.retime, retime, retime.label());
                            }
                        });
                        if slow && dialog.retime != Retime::Nearest {
                            ui.label(canopy_ui::muted("The preview plays it with repeated frames; exports make the smooth ones."));
                        }
                    }
                    if has_sound {
                        let mut keep = !dialog.pitch_shift;
                        if ui.checkbox(&mut keep, "Keep the voice's pitch").on_hover_text("Off: faster sounds higher and slower sounds lower, like a tape").changed() {
                            dialog.pitch_shift = !keep;
                        }
                    }
                    ui.checkbox(&mut dialog.ripple, "Move what comes after it").on_hover_text("Everything after the clip moves along by however much longer or shorter it gets, on every track");
                    let new_length = source / speed;
                    if !dialog.ripple {
                        if let Some(room) = room.filter(|room| new_length > room + 1e-6) {
                            ui.label(egui::RichText::new(format!("Only {room:.2} s fit before the next clip, so it stops there. Tick Move what comes after it to make room.")).font(font::ui(12.0)).color(color::DANGER));
                        }
                    }
                    ui.add_space(8.0);
                    ui.horizontal(|ui| {
                        if primary_button(ui, "Change speed", Mood::Ember).on_hover_text("Enter").clicked() {
                            apply = true;
                        }
                        if quiet_button(ui, "Cancel", None).on_hover_text("Esc").clicked() {
                            close = true;
                        }
                        ui.label(canopy_ui::muted(&format!("{:.2} s → {new_length:.2} s", clip.duration)));
                    });
                });
            });
        if apply || close {
            if let Some(id) = focused_field {
                ui.ctx().memory_mut(|m| m.surrender_focus(id));
            }
            ui.ctx().memory_mut(|m| {
                if let Some(id) = m.focused() {
                    m.surrender_focus(id);
                }
            });
        }
        if apply {
            let dialog = self.speed_dialog.take().unwrap();
            self.change_speed(&dialog);
        } else if close {
            self.speed_dialog = None;
        }
    }

    /// Applies a Change clip speed: one undo step, the clip and its linked clip alike.
    fn change_speed(&mut self, dialog: &SpeedDialog) {
        let before = self.project.clone();
        let Some(was) = self.project.clip(&dialog.clip).map(|c| c.duration) else {
            return;
        };
        if dialog.ripple {
            self.project.set_speed_ripple(&dialog.clip, dialog.speed);
        } else {
            self.project.set_speed(&dialog.clip, dialog.speed);
        }
        let mut family = self.project.partners(&dialog.clip);
        family.push(dialog.clip.clone());
        for id in family {
            if let Some(clip) = self.project.clip_mut(&id) {
                (clip.retime, clip.pitch_shift) = (dialog.retime, dialog.pitch_shift);
            }
        }
        if self.project != before {
            self.history.record(&before);
            self.edited();
            let now = self.project.clip(&dialog.clip).map_or(was, |c| c.duration);
            self.toasts.push(format!("Speed {:.0}%: {was:.2} s → {now:.2} s", dialog.speed * 100.0));
        }
    }

    /// Saves a frame of a video clip as a PNG and puts it in front of the clip as a picture, ready to move around. The
    /// clip is `clip`, else the one picked, else the video clip in front under the playhead. The frame is the one under
    /// the playhead when that's on the clip, else the one at `at` (where it was right-clicked), else its first.
    fn grab_frame(&mut self, clip: Option<String>, at: Option<f64>) {
        let is_video = |p: &Project, id: &str| {
            p.find(id).is_some_and(|r| p.tracks[r.track].kind == crate::project::TrackKind::Video)
                && p.clip(id).and_then(|c| p.media(&c.media_id)).is_some_and(|m| m.kind == MediaKind::Video)
        };
        let picked = self.picked_clips();
        let id = clip
            .or_else(|| match picked.as_slice() {
                [one] if is_video(&self.project, one) => Some(one.clone()),
                _ => None,
            })
            .or_else(|| {
                let t = self.playhead;
                self.project
                    .tracks
                    .iter()
                    .filter(|track| !track.hidden)
                    .flat_map(|track| track.clips.iter())
                    .find(|c| c.contains(t) && is_video(&self.project, &c.id))
                    .map(|c| c.id.clone())
            });
        let Some(clip) = id.filter(|id| is_video(&self.project, id)).and_then(|id| self.project.clip(&id).cloned()) else {
            return self.toasts.push("Pick a video clip, or put the playhead on one, to grab its frame".into());
        };
        let Some(media) = self.project.media(&clip.media_id).cloned() else {
            return;
        };
        if !media.path.is_file() {
            return self.toasts.push("The video is missing: find it in Media first".into());
        }
        let t = if clip.contains(self.playhead) { self.playhead } else { at.unwrap_or(clip.start) };
        let t = t.clamp(clip.start, clip.end() - 1e-3);
        let source_at = clip.source_time(t).clamp(0.0, (media.duration - 1e-3).max(0.0));
        let stem = media.path.file_stem().map_or_else(|| "Frame".into(), |s| s.to_string_lossy().into_owned());
        let whole = source_at.floor() as u64;
        let name = format!("{stem} at {}m{:02}s{:03}.png", whole / 60, whole % 60, ((source_at - whole as f64) * 1000.0).round() as u64 % 1000);
        // One folder per video, so two videos of the same name don't share frames.
        let output = self.place.data_dir.join("frames").join(&media.id).join(name);
        self.worker.send(Job::GrabFrame { clip: clip.id.clone(), at: t, path: media.path.clone(), source_at, output });
        self.toasts.push(format!("Grabbing the frame at {}", timecode(t, self.project.fps)));
    }

    /// The Clip menu's bigger actions, for the menu and the keyboard alike.
    fn clip_op(&mut self, id: &str, op: ClipOp) {
        let Some(clip) = self.project.clip(id).cloned() else {
            return;
        };
        let media = self.project.media(&clip.media_id).cloned();
        let path = media.as_ref().map(|m| m.path.clone());
        let video = media.as_ref().is_some_and(|m| m.kind == MediaKind::Video);
        let sound = media.as_ref().is_some_and(|m| m.has_audio) && !self.project.sounds_elsewhere(&clip);
        match op {
            ClipOp::Proxy(true) => {
                if !video {
                    return self.toasts.push("Proxies are for video clips".into());
                }
                if self.proxy_jobs.contains(&clip.media_id) {
                    return;
                }
                match path.as_deref().and_then(|p| self.proxy_entry(p)) {
                    Some(output) => {
                        self.proxy_jobs.push(clip.media_id.clone());
                        self.worker.send(Job::Proxy { media_id: clip.media_id.clone(), path: path.unwrap(), output });
                        self.toasts.push("Making an editing proxy; long videos take a while".into());
                    }
                    None => self.toasts.push("Couldn't read the video to make a proxy".into()),
                }
            }
            ClipOp::Proxy(false) => match self.preview.proxies.remove(&clip.media_id) {
                Some(file) => {
                    // Stop playing from it before deleting it.
                    self.reset_preview();
                    if std::fs::remove_file(&file).is_err() {
                        self.toasts.push(format!("Couldn't delete the proxy; it's at {}", file.display()));
                    }
                }
                None => self.toasts.push("This video has no editing proxy".into()),
            },
            ClipOp::Loudness(normalize) => {
                let Some(path) = path.filter(|_| sound) else {
                    return self.toasts.push("This clip has no sound of its own".into());
                };
                self.worker.send(Job::Loudness { clip: clip.id.clone(), path, from: clip.source_in, length: clip.source_length(), normalize });
                self.toasts.push("Measuring loudness…".into());
            }
            ClipOp::Scenes => {
                let Some(path) = path.filter(|_| video) else {
                    return self.toasts.push("Scene detection is for video clips".into());
                };
                if self.scene_jobs.contains(&clip.media_id) {
                    return;
                }
                self.scene_jobs.push(clip.media_id.clone());
                self.worker.send(Job::Scenes { media_id: clip.media_id.clone(), path });
                self.toasts.push("Finding scene changes; long videos take a while".into());
            }
            ClipOp::Reframe => {
                let Some(path) = path.filter(|_| video) else {
                    return self.toasts.push("Auto-reframe is for video clips".into());
                };
                if self.focus_jobs.contains(&clip.id) {
                    return;
                }
                self.focus_jobs.push(clip.id.clone());
                self.worker.send(Job::Focus { clip: clip.id.clone(), path, from: clip.source_in, length: clip.source_length() });
                self.toasts.push("Following the action; long clips take a while".into());
            }
            ClipOp::Link(detach) => {
                let was = self.project.clone();
                let done = if detach {
                    video && sound && self.project.linked(&clip.id).is_none() && self.project.detach_sound(&clip.id).is_some()
                } else {
                    self.project.unlink(&clip.id)
                };
                if done {
                    self.history.record(&was);
                    self.edited();
                } else {
                    self.toasts.push(if detach { "Only a video clip with its own sound can detach it".into() } else { "This clip isn't linked".into() });
                }
            }
            ClipOp::Extend(before, seconds) => {
                if media.as_ref().is_some_and(|m| m.kind == MediaKind::Image) {
                    return self.toasts.push("A picture has no more footage to show".into());
                }
                let was = self.project.clone();
                let grown = if before { self.project.extend_start(&clip.id, seconds) } else { self.project.extend_end(&clip.id, seconds) };
                if grown > 0.0 {
                    self.history.record(&was);
                    self.edited();
                } else {
                    self.toasts.push(if before { "That's the start of its video".into() } else { "That's the end of its video".into() });
                }
            }
            ClipOp::Ungroup => {
                let was = self.project.clone();
                if self.project.ungroup(&clip.id) {
                    self.history.record(&was);
                    self.edited();
                } else {
                    self.toasts.push("This clip isn't grouped".into());
                }
            }
        }
    }

    fn toolbar(&mut self, ui: &mut Ui) {
        let narrow = ui.available_width() < NARROW;
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 6.0;
            let name = ui.add(
                egui::TextEdit::singleline(&mut self.project.name)
                    .font(font::bold(15.0))
                    .desired_width(if narrow { 130.0 } else { 220.0 })
                    .margin(vec2(8.0, 6.0)),
            );
            if name.changed() {
                self.edited();
            }
            if icon_button(ui, Icon::Undo, "Undo (Ctrl+Z)", false).clicked()
                && self.history.undo(&mut self.project)
            {
                self.edited();
            }
            if icon_button(ui, Icon::Redo, "Redo (Ctrl+Shift+Z)", false).clicked()
                && self.history.redo(&mut self.project)
            {
                self.edited();
            }
            let import = if narrow {
                icon_button(ui, Icon::Plus, "Import (Ctrl+I)", false)
            } else {
                quiet_button(ui, "Import", Some(Icon::Plus)).on_hover_text("Ctrl+I")
            };
            if import.clicked() {
                self.import_dialog();
            }
            let codex = if narrow {
                icon_button(ui, Icon::Text, "Codex: edit with Codex (Alt+B)", self.codex.open)
            } else {
                quiet_button(ui, "Codex", Some(Icon::Text)).on_hover_text("Edit with Codex (Alt+B)")
            };
            if codex.clicked() {
                self.codex_toggle();
            }
            let current = SHAPES
                .iter()
                .position(|&(_, w, h)| (self.project.width, self.project.height) == (w, h));
            let mut shape = None;
            if narrow {
                // One pill that steps through the shapes.
                let label = current.map_or("Shape", |i| SHAPES[i].0);
                if pill(ui, label, None, false)
                    .on_hover_text("Change the shape: 16:9, 9:16 or 1:1")
                    .clicked()
                {
                    shape = Some(current.map_or(0, |i| (i + 1) % SHAPES.len()));
                }
            } else {
                for (i, (label, _, _)) in SHAPES.iter().enumerate() {
                    if pill(ui, label, None, current == Some(i)).clicked() && current != Some(i) {
                        shape = Some(i);
                    }
                }
            }
            if let Some(i) = shape {
                self.set_shape(i);
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if primary_button(ui, "Export", Mood::Ember).on_hover_text("Ctrl+E").clicked() && self.export.is_none() {
                    self.start_export(ui.ctx());
                }
                let waiting = self
                    .queue
                    .iter()
                    .filter(|q| matches!(q.status, Status::Waiting | Status::Rendering(_)))
                    .count();
                let label = if waiting > 0 {
                    format!("Queue ({waiting})")
                } else {
                    "Queue".into()
                };
                if quiet_button(ui, &label, None)
                    .on_hover_text("Render with presets, one after another, while you keep editing (Ctrl+Shift+E)")
                    .clicked()
                {
                    self.show_deliver = !self.show_deliver;
                }
                let projects = if narrow {
                    icon_button(ui, Icon::Project, "Projects (Ctrl+O)", self.show_projects)
                } else {
                    quiet_button(ui, "Projects", Some(Icon::Project)).on_hover_text("Ctrl+O")
                };
                if projects.clicked() {
                    self.show_projects = !self.show_projects;
                }
                let even = self.project.even_loudness;
                let hint =
                    "Even out the loudness when exporting, to the -14 LUFS social apps play at";
                let toggle = if narrow {
                    icon_button(ui, Icon::Audio, hint, even)
                } else {
                    pill(ui, "Even loudness", None, even).on_hover_text(hint)
                };
                if toggle.clicked() {
                    self.history.record(&self.project);
                    self.project.even_loudness = !even;
                    self.edited();
                }
                let mut format = self.project.export_format;
                egui::ComboBox::from_id_salt("streamcuts-export-format")
                    .selected_text(format.label())
                    .width(120.0)
                    .show_ui(ui, |ui| {
                        for choice in ExportFormat::ALL {
                            ui.selectable_value(&mut format, choice, choice.label());
                        }
                    })
                    .response
                    .on_hover_text("What Export makes");
                if format != self.project.export_format {
                    self.history.record(&self.project);
                    self.project.export_format = format;
                    self.edited();
                }
            });
        });
    }

    fn boss_window(&mut self, ui: &mut Ui) {
        let Some(plan) = &self.boss_plan else { return };
        let mut selected = None;
        let modal = egui::Modal::new(ui.scope_id().with("boss-plan")).show(ui.ctx(), |ui| {
            ui.set_width(440.0);
            ui.label(egui::RichText::new("Shorts Boss found").font(font::display(20.0)));
            ui.label("Pick a moment to open it as a 9:16 project with a title and captions.");
            ui.add_space(8.0);
            egui::ScrollArea::vertical()
                .max_height(360.0)
                .show(ui, |ui| {
                    for (index, short) in plan.suggestions.iter().enumerate() {
                        let label = format!(
                            "{}  ·  {}–{}",
                            short.title,
                            timecode(short.start_seconds, self.project.fps),
                            timecode(short.end_seconds, self.project.fps)
                        );
                        if quiet_button(ui, &label, Some(Icon::Scissors)).clicked() {
                            selected = Some(index);
                        }
                        if !short.description.is_empty() {
                            ui.label(&short.description);
                        }
                        ui.add_space(6.0);
                    }
                });
        });
        if let Some(index) = selected {
            let short = self.boss_plan.as_ref().unwrap().suggestions[index].clone();
            let media_id = self.boss_plan.as_ref().unwrap().media_id.clone();
            self.open_boss_short(&media_id, &short);
            self.boss_plan = None;
        } else if modal.should_close() {
            self.boss_plan = None;
        }
    }

    fn open_boss_short(&mut self, media_id: &str, short: &Suggestion) {
        let Some(media) = self.project.media(media_id).cloned() else {
            return;
        };
        let mut project = Project::new(&short.title);
        project.width = 1080;
        project.height = 1920;
        let id = project.add_media(media.clone());
        let Some(clip_id) = project.place(&id, None, 0.0) else {
            return;
        };
        if let Some(clip) = project.clip_mut(&clip_id) {
            clip.source_in = short.start_seconds;
            clip.duration = short.end_seconds - short.start_seconds;
            clip.framing = Framing::Fill { x: 0.5, y: 0.5 };
        }
        let title_id = project.add_title(0.0);
        if let Some(title) = project.title_mut(&title_id) {
            title.text = short.title.clone();
            title.end = 3.0_f64.min(short.end_seconds - short.start_seconds);
            title.y = 0.22;
        }
        self.open(project);
        self.edited();
        if media.has_audio {
            self.worker.send(Job::Transcribe {
                clip: clip_id,
                path: media.path,
                from: short.start_seconds,
                length: short.end_seconds - short.start_seconds,
                speed: 1.0,
                at: 0.0,
            });
            self.transcribing += 1;
        }
    }

    /// Asks where a missing file went and points the project there. The clips keep their place and trims.
    fn find_media(&mut self, id: &str) {
        let Some(media) = self.project.media(id).cloned() else {
            return;
        };
        let mut dialog = rfd::FileDialog::new().set_title(format!("Where is {}?", media.name));
        if let Some(folder) = media.path.parent().filter(|f| f.is_dir()) {
            dialog = dialog.set_directory(folder);
        }
        let Some(path) = dialog.pick_file() else {
            return;
        };
        self.replace_media_file(id, path);
    }

    /// Points a media at another file (found again, or edited elsewhere): every clip of it shows the new one and
    /// keeps its place and trims. One undo step.
    fn replace_media_file(&mut self, id: &str, path: PathBuf) {
        self.history.record(&self.project);
        if let Some(target) = self.project.media.iter_mut().find(|m| m.id == id) {
            target.name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or(target.name.clone());
            if target.kind == MediaKind::Image {
                if let Ok((w, h)) = image::image_dimensions(&path) {
                    (target.width, target.height) = (w, h);
                }
            }
            target.path = path;
        }
        self.looks.thumbnails.remove(id);
        self.looks_asked.remove(id);
        self.reset_preview();
        self.request_looks();
        self.edited();
    }

    /// Right-click > Edit the picture in Folio: Canopy opens the picture in Folio, whose Save sends the edited one
    /// back to [`CanopyApp::open_document`] as `edited-picture:`, where it replaces this one.
    fn edit_in_folio(&mut self, clip: &str, host: &mut dyn Host) {
        let Some(media) = self.project.clip(clip).and_then(|c| self.project.media(&c.media_id)).cloned() else {
            return self.toasts.push("Pick a picture clip to edit it in Folio".into());
        };
        if !folio_can_edit(&media) {
            return self.toasts.push("Folio edits still PNG, JPEG and WebP pictures".into());
        }
        if !media.path.is_file() {
            return self.toasts.push("The picture is missing: find it in Media first".into());
        }
        // Saved, so the edited picture finds this project again even if another one is open by then.
        if let Err(error) = self.save() {
            return self.toasts.push(format!("Couldn't save the project first: {error}"));
        }
        let reply = serde_json::json!({ "project": self.project.id, "media": media.id }).to_string();
        let request = serde_json::json!({ "path": media.path.to_string_lossy(), "app": "streamcuts", "reply": reply });
        if !host.open_in("folio", &format!("{EDIT_PICTURE}{request}")) {
            self.toasts.push("Editing in Folio works when StreamCuts runs inside Canopy".into());
        }
    }

    /// Folio's edited picture coming back (`edited-picture:{"path", "reply"}`): it replaces the picture in the
    /// project that sent it, opening that project if another one is open.
    fn take_edited_picture(&mut self, json: &str) -> Result<String, String> {
        let unreadable = || "StreamCuts couldn't read what Folio sent back".to_string();
        let back: serde_json::Value = serde_json::from_str(json).map_err(|_| unreadable())?;
        let path = PathBuf::from(back["path"].as_str().ok_or_else(unreadable)?);
        let reply: serde_json::Value = serde_json::from_str(back["reply"].as_str().ok_or_else(unreadable)?).map_err(|_| unreadable())?;
        let (project, media) = (reply["project"].as_str().ok_or_else(unreadable)?, reply["media"].as_str().ok_or_else(unreadable)?);
        if !path.is_file() {
            return Err(format!("The edited picture isn't there any more: {}", path.display()));
        }
        if self.project.id != project {
            let file = storage::find(&self.place.projects_dir, project).ok_or("The project the picture came from is gone")?;
            self.open(storage::load(&file)?);
        }
        let name = self.project.media(media).map(|m| m.name.clone()).ok_or("The picture is no longer in this project's Media")?;
        self.replace_media_file(media, path);
        let _ = self.save();
        Ok(format!("Replaced {name} with Folio's edit"))
    }

    fn start_export(&mut self, ctx: &egui::Context) {
        if let Some(media) = self.project.missing_media().first() {
            self.toasts.push(format!(
                "Can't export: {} is missing. Click it in Media to find it.",
                media.name
            ));
            return;
        }
        let _ = std::fs::create_dir_all(&self.place.exports_dir);
        let name = canopy_ui::canopy_core::files::unique_name(
            &self.place.exports_dir,
            &format!(
                "{}.{}",
                self.project.name,
                self.project.export_format.extension()
            ),
        );
        let output = self.place.exports_dir.join(name);
        match export::start(&self.project, &output, ctx.clone()) {
            Ok(run) => {
                self.export = Some(run);
                self.exported.push(output);
            }
            Err(error) => self.toasts.push(error),
        }
    }

    fn media_bin(&mut self, ui: &mut Ui) {
        ui.label(
            egui::RichText::new("Media")
                .font(font::ui(12.0))
                .color(color::INK_MUTED),
        );
        if self.project.media.is_empty() {
            ui.add_space(12.0);
            ui.label(
                egui::RichText::new("Import video, pictures or sound, or drop files here.")
                    .color(color::INK_MUTED),
            );
            return;
        }
        // A search (words, #tag, 3* for three stars or more), and saved searches to pick from: the smart bins.
        let searching = !self.media_search.trim().is_empty();
        ui.horizontal(|ui| {
            let width = ui.available_width() - if searching { 76.0 } else { 0.0 };
            let search = ui.add(egui::TextEdit::singleline(&mut self.media_search).hint_text("Search: words, #tag, 3*  (Ctrl+F)").desired_width(width))
                .on_hover_text("Words match names, notes and tags; #tag needs that tag; 3* needs three stars or more. Enter or Esc goes back to editing.");
            if std::mem::take(&mut self.focus_media_search) {
                search.request_focus();
            }
            if searching && ui.small_button("Save bin").on_hover_text("Keep this search as a smart bin").clicked() {
                let query = self.media_search.trim().to_owned();
                if !self.project.smart_bins.iter().any(|bin| bin.query == query) {
                    self.history.record(&self.project);
                    self.project.smart_bins.push(crate::project::SmartBin { id: crate::project::new_id(), name: query.clone(), query });
                    self.edited();
                }
            }
        });
        let mut forget = None;
        if !self.project.smart_bins.is_empty() {
            ui.horizontal_wrapped(|ui| {
                for bin in &self.project.smart_bins {
                    let on = self.media_search.trim() == bin.query;
                    if ui
                        .selectable_label(on, &bin.name)
                        .on_hover_text("A smart bin: click to show what it finds")
                        .clicked()
                    {
                        self.media_search = if on { String::new() } else { bin.query.clone() };
                    }
                    if ui
                        .small_button("×")
                        .on_hover_text("Delete this smart bin")
                        .clicked()
                    {
                        forget = Some(bin.id.clone());
                    }
                }
            });
        }
        if let Some(id) = forget {
            self.history.record(&self.project);
            self.project.smart_bins.retain(|bin| bin.id != id);
            self.edited();
        }
        ui.add_space(4.0);
        // A file selected here is what Delete removes, while no clip is selected on the timeline.
        if !self.timeline.selection.is_empty() {
            self.media_selected = None;
        }
        let mut place_now = None;
        let mut find = None;
        let mut remove = None;
        let mut select = None;
        let mut scenes = None;
        // Changes to a file's rating, tags or notes: (media id, its new attributes, whether to keep an undo step).
        let mut noted: Option<(String, crate::project::Attributes, bool)> = None;
        let query = self.media_search.clone();
        let shown: Vec<&crate::project::Media> = self
            .project
            .media
            .iter()
            .filter(|m| m.matches(&query))
            .collect();
        if shown.is_empty() {
            ui.label(egui::RichText::new("Nothing matches this search.").color(color::INK_MUTED));
        }
        let scroll_to = self.media_scroll_to.take();
        egui::ScrollArea::vertical().auto_shrink(false).show(ui, |ui| {
            for media in shown {
                let missing = !media.path.is_file();
                let used = self.project.tracks.iter().any(|t| t.clips.iter().any(|c| c.media_id == media.id));
                // The row takes clicks and drags itself (see `canopy_ui::drag_source`).
                let (rect, row) = ui.allocate_exact_size(vec2(ui.available_width(), 46.0), Sense::click_and_drag());
                // Picked with Page Up or Page Down: bring it into view.
                if scroll_to.as_deref() == Some(media.id.as_str()) {
                    row.scroll_to_me(Some(egui::Align::Center));
                }
                let painter = ui.painter();
                if self.media_selected.as_deref() == Some(media.id.as_str()) {
                    painter.rect(rect, 8, color::VEIL_STRONG, egui::Stroke::new(1.5, color::SUN), egui::StrokeKind::Inside);
                } else {
                    painter.rect_filled(rect, 8, color::VEIL);
                }
                let thumb = Rect::from_min_size(rect.min + vec2(4.0, 4.0), vec2(68.0, 38.0));
                match self.looks.thumbnails.get(&media.id) {
                    Some(texture) => {
                        painter.image(texture.id(), thumb, Rect::from_min_max(pos2(0.0, 0.0), pos2(1.0, 1.0)), Color32::WHITE);
                    }
                    None => {
                        painter.rect_filled(thumb, 4, color::VEIL_STRONG);
                        let which = match media.kind { MediaKind::Audio => Icon::Audio, MediaKind::Image => Icon::Image, MediaKind::Video => Icon::Video };
                        icon(painter, Rect::from_center_size(thumb.center(), vec2(18.0, 18.0)), which, color::INK_SOFT);
                    }
                }
                let text = painter.with_clip_rect(Rect::from_min_max(pos2(thumb.right() + 8.0, rect.top()), rect.max - vec2(30.0, 0.0)));
                // The name stops short of its stars, which sit right to left before the menu button (the fonts have no star).
                let stars = media.attributes.rating as f32 * 12.0;
                let name = painter.with_clip_rect(Rect::from_min_max(pos2(thumb.right() + 8.0, rect.top()), pos2(rect.right() - 34.0 - stars, rect.bottom())));
                name.text(pos2(thumb.right() + 8.0, rect.top() + 8.0), Align2::LEFT_TOP, &media.name, font::ui(13.0), color::INK);
                for k in 0..media.attributes.rating {
                    star(painter, pos2(rect.right() - 40.0 - k as f32 * 12.0, rect.top() + 15.0), 5.5, color::SUN);
                }
                if missing {
                    text.text(pos2(thumb.right() + 8.0, rect.bottom() - 7.0), Align2::LEFT_BOTTOM, "Missing: click to find it", font::ui(11.0), color::SUN);
                } else {
                    let mut detail = match media.kind { MediaKind::Image => format!("{} · {}×{}", if media.loop_length().is_some() { "Animated" } else { "Picture" }, media.width, media.height), _ => timecode(media.duration, self.project.fps) };
                    for tag in &media.attributes.tags {
                        detail.push_str(&format!(" · #{tag}"));
                    }
                    if self.proxy_jobs.contains(&media.id) {
                        detail.push_str(" · making proxy…");
                    } else if self.preview.proxies.contains_key(&media.id) {
                        detail.push_str(" · proxy");
                    }
                    text.text(pos2(thumb.right() + 8.0, rect.bottom() - 7.0), Align2::LEFT_BOTTOM, detail, font::ui(11.0), color::INK_MUTED);
                }
                // The file's menu: on its button, or a right-click on the row.
                let mut menu = |ui: &mut Ui| {
                    ui.set_min_width(220.0);
                    let mut attributes = media.attributes.clone();
                    ui.horizontal(|ui| {
                        ui.label("Rating");
                        for stars in 1..=5u8 {
                            let (spot, response) = ui.allocate_exact_size(vec2(20.0, 20.0), Sense::click());
                            let lit = attributes.rating >= stars;
                            star(ui.painter(), spot.center(), if response.hovered() { 9.0 } else { 8.0 }, if lit { color::SUN } else { color::INK_MUTED });
                            if response.on_hover_text(format!("{stars} of 5; click again to clear")).clicked() {
                                attributes.rating = if attributes.rating == stars { 0 } else { stars };
                            }
                        }
                    });
                    ui.horizontal_wrapped(|ui| {
                        ui.label("Tags");
                        let mut gone = None;
                        for (i, tag) in attributes.tags.iter().enumerate() {
                            if ui.small_button(format!("#{tag} ×")).on_hover_text("Remove this tag").clicked() {
                                gone = Some(i);
                            }
                        }
                        if let Some(i) = gone {
                            attributes.tags.remove(i);
                        }
                    });
                    let draft = ui.scope_id().with("new-tag");
                    let mut tag: String = ui.data(|d| d.get_temp(draft)).unwrap_or_default();
                    let field = ui.add(egui::TextEdit::singleline(&mut tag).hint_text("Add a tag, then Enter").desired_width(200.0));
                    if field.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter)) {
                        let mut tagged = media.clone();
                        tagged.attributes = attributes.clone();
                        if tagged.add_tag(&tag) {
                            attributes = tagged.attributes;
                        }
                        tag.clear();
                        field.request_focus();
                    }
                    ui.data_mut(|d| d.insert_temp(draft, tag));
                    ui.label("Notes");
                    let notes = ui.add(egui::TextEdit::multiline(&mut attributes.notes).desired_rows(3).desired_width(200.0));
                    if attributes != media.attributes {
                        // Typing a note keeps one undo step for all of it.
                        let typing = notes.changed();
                        noted = Some((media.id.clone(), attributes, !(typing && self.media_typing)));
                        self.media_typing |= typing;
                    }
                    if !notes.has_focus() {
                        self.media_typing = false;
                    }
                    ui.separator();
                    if media.kind == MediaKind::Video && !missing {
                        let busy = self.scene_jobs.contains(&media.id);
                        if ui.add_enabled(used && !busy, egui::Button::new(if busy { "Finding scenes…" } else { "Detect scenes" }))
                            .on_disabled_hover_text("Put it on the timeline first: scene changes become markers there")
                            .on_hover_text("Mark where the picture cuts to another scene")
                            .clicked()
                        {
                            scenes = Some((media.id.clone(), media.path.clone()));
                            ui.close();
                        }
                    }
                    let clips = self.project.clips_using(&media.id);
                    let label = match clips {
                        0 => "Remove from project".to_owned(),
                        1 => "Remove from project, with its clip".to_owned(),
                        n => format!("Remove from project, with its {n} clips"),
                    };
                    if ui
                        .button(label)
                        .on_hover_text("The file stays on disk. Delete does this to the selected file; Ctrl+Z brings it back.")
                        .clicked()
                    {
                        remove = Some(media.id.clone());
                        ui.close();
                    }
                };
                let button = Rect::from_center_size(pos2(rect.right() - 16.0, rect.center().y), vec2(24.0, 24.0));
                ui.scope_builder(UiBuilder::new().max_rect(button), |ui| {
                    ui.style_mut().wrap_mode = Some(egui::TextWrapMode::Extend);
                    egui::containers::menu::MenuButton::new("···").config(stays_open()).ui(ui, |ui| menu(ui));
                });
                let row = row.on_hover_text(media.info());
                egui::Popup::context_menu(&row).close_behavior(egui::PopupCloseBehavior::CloseOnClickOutside).show(|ui| menu(ui));
                // Dragged onto the timeline, it's placed where it lands.
                canopy_ui::drag_source(ui, &row, || MediaDrag(media.id.clone()), &media.name);
                if row.clicked() || row.secondary_clicked() {
                    select = Some(media.id.clone());
                }
                if missing && row.clicked() {
                    find = Some(media.id.clone());
                } else if row.double_clicked() {
                    place_now = Some(media.id.clone());
                }
                ui.add_space(2.0);
            }
        });
        if let Some((id, attributes, step)) = noted {
            if step {
                self.history.record(&self.project);
            }
            if let Some(media) = self.project.media.iter_mut().find(|m| m.id == id) {
                media.attributes = attributes;
            }
            self.edited();
        }
        if let Some(id) = find {
            self.find_media(&id);
        }
        if let Some((media_id, path)) = scenes {
            self.scene_jobs.push(media_id.clone());
            self.worker.send(Job::Scenes { media_id, path });
            self.toasts
                .push("Finding scene changes; long videos take a while".into());
        }
        if let Some(id) = select {
            self.media_selected = Some(id);
            self.timeline.selection.clear();
        }
        if let Some(id) = remove {
            self.remove_media(&id);
        }
        if let Some(id) = place_now {
            self.history.record(&self.project);
            if let Some(clip) = self.project.place(&id, None, self.playhead) {
                self.timeline.selection = vec![clip];
                self.edited();
            }
        }
    }

    fn preview(&mut self, ui: &mut Ui) {
        let full = ui.available_rect_before_wrap();
        let transport = 44.0;
        let area = Rect::from_min_max(full.min, pos2(full.right(), full.bottom() - transport));
        let aspect = self.project.width as f32 / self.project.height as f32;
        let size = if area.width() / area.height() > aspect {
            vec2(area.height() * aspect, area.height())
        } else {
            vec2(area.width(), area.width() / aspect)
        };
        let screen = Rect::from_center_size(area.center(), size);
        ui.painter().rect_filled(screen, 4, Color32::BLACK);
        if let (Some(texture), false) = (&self.preview.texture, self.preview.blank) {
            // A clip fading in or out shows darker (exports fade it to what's below, which is black unless tracks stack).
            let fade = if self.project.crossfade_at(self.playhead).is_some() {
                1.0
            } else {
                self.project
                    .front_clip(self.playhead)
                    .map_or(1.0, |(clip, _)| {
                        if self.project.crossfade_before(&clip.id).is_some() {
                            if clip.fade_out > 0.0 {
                                ((clip.end() - self.playhead) / clip.fade_out).clamp(0.0, 1.0)
                            } else {
                                1.0
                            }
                        } else {
                            clip.fade_at(self.playhead)
                        }
                    })
            };
            let tint = Color32::from_gray((fade * 255.0).round() as u8);
            // Tracks below show where a moved, resized or cropped clip leaves the frame open, bottom first.
            let painter = ui.painter().with_clip_rect(screen);
            let layers = self.project.layers_at(self.playhead);
            for track in layers.iter().skip(1).rev() {
                if let (Some(layer), Some((clip, _))) = (
                    self.under.get(track).filter(|l| !l.blank),
                    self.project.clip_on(*track, self.playhead),
                ) {
                    if let Some(texture) = &layer.texture {
                        let (rect, uv) = placed(screen, &clip.place);
                        painter.image(texture.id(), rect, uv, Color32::WHITE);
                    }
                }
            }
            let front = self
                .project
                .front_clip(self.playhead)
                .map(|(clip, _)| clip.place)
                .unwrap_or_default();
            let (rect, uv) = placed(screen, &front);
            painter.image(texture.id(), rect, uv, tint);
            // Scrubbing: until the exact still arrives (a static FFmpeg takes half a second to start), show the nearest
            // filmstrip frame, which is there at once. Only when it looks the same: a 16:9 frame, fitted, ungraded.
            if self.preview.waiting() && self.project.width * 9 == self.project.height * 16 {
                if let Some((clip, media)) =
                    self.project.front_clip(self.playhead).filter(|(clip, _)| {
                        clip.picture() == Picture::default() && clip.place.is_full()
                    })
                {
                    if let Some(strip) = self.looks.filmstrips.get(&media.id) {
                        ui.painter().image(
                            strip.texture.id(),
                            screen,
                            strip.uv(clip.source_time(self.playhead)),
                            tint,
                        );
                    }
                }
            }
        }
        // What's on the picture and where, front first, for picking and dragging (see `edit_on_picture`).
        let mut elements: Vec<(Target, Rect)> = Vec::new();
        let over_picture = ui.painter().with_clip_rect(screen);
        for title in self
            .project
            .titles
            .iter()
            .filter(|t| self.playhead >= t.start && self.playhead < t.end)
        {
            let rect = captions::draw_title(&over_picture, screen, title);
            elements.insert(0, (Target::Title(title.id.clone()), rect));
        }
        if let Some(caption) = self.project.caption_at(self.playhead) {
            let word = self
                .project
                .caption_words
                .then(|| caption.word_at(self.playhead))
                .flatten();
            let rect = captions::draw(&over_picture, screen, &caption.text, word, &self.project);
            elements.insert(0, (Target::Captions(caption.id.clone()), rect));
        }
        if !self.preview.blank {
            for track in self.project.layers_at(self.playhead) {
                if let Some((clip, _)) = self.project.clip_on(track, self.playhead) {
                    elements.push((Target::Clip(clip.id.clone()), placed(screen, &clip.place).0));
                }
            }
        }
        if self.preview.scopes.on {
            self.preview.scopes.draw(
                ui.painter(),
                Rect::from_min_size(
                    pos2(area.right() - 268.0, area.top() + 8.0),
                    vec2(256.0, 210.0),
                ),
            );
        }
        self.edit_on_picture(ui, screen, &elements);
        if self.project.duration() == 0.0 {
            ui.painter().text(
                screen.center(),
                Align2::CENTER_CENTER,
                "Drag media onto the timeline to start",
                font::ui(14.0),
                color::INK_MUTED,
            );
        } else if let Some((_, media)) = self
            .project
            .front_clip(self.playhead)
            .filter(|(_, media)| !media.path.is_file())
        {
            ui.painter().text(
                screen.center(),
                Align2::CENTER_CENTER,
                format!("{} is missing: find it in Media", media.name),
                font::ui(14.0),
                color::INK_MUTED,
            );
        }
        let bar = Rect::from_min_max(pos2(full.left(), full.bottom() - transport + 6.0), full.max);
        ui.scope_builder(UiBuilder::new().max_rect(bar), |ui| {
            ui.horizontal_centered(|ui| {
                ui.add_space((bar.width() / 2.0 - 70.0).max(0.0));
                if icon_button(ui, Icon::SkipBack, "Go to start (Home)", false).clicked() {
                    self.seek(0.0);
                }
                let playing = self.clock.playing;
                if icon_button(
                    ui,
                    if playing { Icon::Pause } else { Icon::Play },
                    if playing {
                        "Pause (Space)"
                    } else {
                        "Play (Space)"
                    },
                    false,
                )
                .clicked()
                {
                    self.toggle_play();
                }
                if icon_button(ui, Icon::SkipForward, "Go to end (End)", false).clicked() {
                    self.seek(self.project.duration());
                }
                ui.label(
                    egui::RichText::new(format!(
                        "{} / {}",
                        timecode(self.playhead, self.project.fps),
                        timecode(self.project.duration(), self.project.fps)
                    ))
                    .font(font::ui(13.0))
                    .color(color::INK_SOFT),
                );
                ui.add_space(12.0);
                let on = self.preview.scopes.on;
                if ui
                    .selectable_label(on, "Scopes")
                    .on_hover_text("Histogram and luma waveform of the picture")
                    .clicked()
                {
                    self.preview.scopes.on = !on;
                    // Measured from the next picture shown: ask for the one here again.
                    if !on {
                        self.reset_preview();
                    }
                }
            });
        });
    }

    /// Moving, resizing and cropping on the picture, as in a photo editor. A click picks what's under the pointer (a
    /// title, the captions, or a clip, front first); the picked one gets a box: drag inside to move it, a corner to
    /// resize it, and, for clips, an edge to crop it. `elements` is what's on the picture and where, front first.
    fn edit_on_picture(&mut self, ui: &mut Ui, screen: Rect, elements: &[(Target, Rect)]) {
        let response = ui.interact(
            screen,
            ui.scope_id().with("edit-on-picture"),
            Sense::click_and_drag(),
        );
        let selected = self.timeline.selection.as_slice();
        let chosen = match selected {
            [id] => elements
                .iter()
                .find(|(target, _)| target.id() == id)
                .cloned(),
            _ => None,
        };
        // While a drag is on, its element stays chosen even if the selection list hasn't caught up.
        let chosen = chosen.or_else(|| {
            let drag = self.picture_drag.as_ref()?;
            elements
                .iter()
                .find(|(target, _)| *target == drag.target)
                .cloned()
        });
        let handle = 9.0;
        let grip_at = |p: Pos2, target: &Target, rect: Rect| -> Option<Grip> {
            for sx in [-1i8, 1] {
                for sy in [-1i8, 1] {
                    let corner = pos2(
                        if sx < 0 { rect.left() } else { rect.right() },
                        if sy < 0 { rect.top() } else { rect.bottom() },
                    );
                    if corner.distance(p) <= handle {
                        return Some(Grip::Corner(sx, sy));
                    }
                }
            }
            if matches!(target, Target::Clip(_)) {
                let near_x = (rect.top()..=rect.bottom()).contains(&p.y);
                let near_y = (rect.left()..=rect.right()).contains(&p.x);
                for (side, hit) in [
                    (0, near_x && (p.x - rect.left()).abs() <= handle / 1.5),
                    (2, near_x && (p.x - rect.right()).abs() <= handle / 1.5),
                    (1, near_y && (p.y - rect.top()).abs() <= handle / 1.5),
                    (3, near_y && (p.y - rect.bottom()).abs() <= handle / 1.5),
                ] {
                    if hit {
                        return Some(Grip::Edge(side));
                    }
                }
            }
            rect.contains(p).then_some(Grip::Move)
        };
        let topmost = |p: Pos2| elements.iter().find(|(_, rect)| rect.contains(p)).cloned();
        // The chosen element's box: corners resize; a clip's edge bars crop.
        if let Some((target, rect)) = &chosen {
            let painter = ui.painter().with_clip_rect(screen.expand(handle));
            painter.rect_stroke(
                *rect,
                0.0,
                Stroke::new(1.5, color::SUN),
                egui::StrokeKind::Middle,
            );
            for corner in [
                rect.left_top(),
                rect.right_top(),
                rect.left_bottom(),
                rect.right_bottom(),
            ] {
                painter.rect(
                    Rect::from_center_size(corner, vec2(9.0, 9.0)),
                    2,
                    Color32::WHITE,
                    Stroke::new(1.0, color::SUN),
                    egui::StrokeKind::Middle,
                );
            }
            if matches!(target, Target::Clip(_)) {
                for (at, size) in [
                    (rect.left_center(), vec2(4.0, 16.0)),
                    (rect.right_center(), vec2(4.0, 16.0)),
                    (rect.center_top(), vec2(16.0, 4.0)),
                    (rect.center_bottom(), vec2(16.0, 4.0)),
                ] {
                    painter.rect_filled(Rect::from_center_size(at, size), 2, color::SUN);
                }
            }
        }
        if let Some(p) = response.hover_pos() {
            let grip = self
                .picture_drag
                .as_ref()
                .map(|d| d.grip)
                .or_else(|| chosen.as_ref().and_then(|(t, r)| grip_at(p, t, *r)));
            let cursor = match grip {
                Some(Grip::Corner(sx, sy)) if sx == sy => Some(egui::CursorIcon::ResizeNwSe),
                Some(Grip::Corner(..)) => Some(egui::CursorIcon::ResizeNeSw),
                Some(Grip::Edge(0 | 2)) => Some(egui::CursorIcon::ResizeHorizontal),
                Some(Grip::Edge(_)) => Some(egui::CursorIcon::ResizeVertical),
                Some(Grip::Move) => Some(egui::CursorIcon::Move),
                None => topmost(p).map(|_| egui::CursorIcon::PointingHand),
            };
            if let Some(cursor) = cursor {
                ui.ctx().set_cursor_icon(cursor);
            }
        }
        if response.clicked() {
            if let Some(p) = response.interact_pointer_pos() {
                if !chosen
                    .as_ref()
                    .is_some_and(|(t, r)| grip_at(p, t, *r).is_some())
                {
                    self.timeline.selection = topmost(p)
                        .map(|(t, _)| t.id().to_owned())
                        .into_iter()
                        .collect();
                    self.media_selected = None;
                }
            }
        }
        if response.drag_started() {
            if let Some(p) = ui.input(|i| i.pointer.press_origin()) {
                // Grab the chosen element by a handle or inside it, else whatever is under the pointer, to move it.
                let grabbed = chosen
                    .as_ref()
                    .and_then(|(t, r)| grip_at(p, t, *r).map(|g| (t.clone(), *r, g)))
                    .or_else(|| topmost(p).map(|(t, r)| (t, r, Grip::Move)));
                if let Some((target, rect, grip)) = grabbed {
                    self.timeline.selection = vec![target.id().to_owned()];
                    self.media_selected = None;
                    self.history.record(&self.project);
                    let (place, text) = match &target {
                        Target::Clip(id) => (
                            self.project.clip(id).map(|c| c.place).unwrap_or_default(),
                            (0.0, 0.0, 0.0),
                        ),
                        Target::Title(id) => (
                            Placement::default(),
                            self.project
                                .titles
                                .iter()
                                .find(|t| &t.id == id)
                                .map_or((0.5, 0.5, 0.09), |t| (t.x, t.y, t.size)),
                        ),
                        Target::Captions(_) => (
                            Placement::default(),
                            (
                                self.project.caption_x,
                                self.project.caption_bottom,
                                self.project.caption_size,
                            ),
                        ),
                    };
                    self.picture_drag = Some(PictureDrag {
                        target,
                        grip,
                        start: p,
                        place,
                        text,
                        center: rect.center(),
                    });
                }
            }
        }
        if let (true, Some(drag), Some(p)) = (
            response.dragged(),
            self.picture_drag.clone(),
            response.interact_pointer_pos(),
        ) {
            let d = (p - drag.start) / screen.size();
            let frac = |q: Pos2| {
                (
                    (q.x - screen.left()) / screen.width(),
                    (q.y - screen.top()) / screen.height(),
                )
            };
            let (px, py) = frac(p);
            match &drag.target {
                Target::Clip(id) => {
                    let mut place = drag.place;
                    let [l, t, r, b] = place.crop;
                    let [left, top, right, bottom] = place.shown();
                    match drag.grip {
                        Grip::Move => {
                            place.x += d.x;
                            place.y += d.y;
                        }
                        Grip::Corner(sx, sy) => {
                            // The opposite corner stays; the picture keeps its shape.
                            let (ox, oy) = (
                                if sx < 0 { right } else { left },
                                if sy < 0 { bottom } else { top },
                            );
                            let ratio = ((px - ox).abs() / (right - left))
                                .max((py - oy).abs() / (bottom - top));
                            place.scale =
                                (place.scale * ratio).clamp(crate::project::MIN_SCALE, 10.0);
                            let s = place.scale;
                            place.x = if sx > 0 {
                                ox + s / 2.0 - s * l
                            } else {
                                ox + s / 2.0 - s * (1.0 - r)
                            };
                            place.y = if sy > 0 {
                                oy + s / 2.0 - s * t
                            } else {
                                oy + s / 2.0 - s * (1.0 - b)
                            };
                        }
                        Grip::Edge(side) => {
                            // The picture stays put; the edge cuts into it (or gives back what was cut).
                            let (s, picture_left, picture_top) = (
                                place.scale,
                                place.x - place.scale / 2.0,
                                place.y - place.scale / 2.0,
                            );
                            match side {
                                0 => place.crop[0] = (px - picture_left) / s,
                                2 => place.crop[2] = 1.0 - (px - picture_left) / s,
                                1 => place.crop[1] = (py - picture_top) / s,
                                _ => place.crop[3] = 1.0 - (py - picture_top) / s,
                            }
                        }
                    }
                    let place = place.tidy();
                    if let Some(clip) = self.project.clip_mut(id) {
                        if clip.place != place {
                            clip.place = place;
                            self.edited();
                        }
                    }
                }
                target => {
                    let (x0, y0, size0) = drag.text;
                    let (x, y, size) = match drag.grip {
                        Grip::Corner(..) => {
                            // Bigger or smaller by how far the corner goes from the middle of the text.
                            let ratio =
                                drag.center.distance(p) / drag.center.distance(drag.start).max(1.0);
                            (x0, y0, (size0 * ratio).clamp(0.02, 0.4))
                        }
                        _ => (
                            x0 + d.x,
                            y0 + if matches!(target, Target::Captions(_)) {
                                -d.y
                            } else {
                                d.y
                            },
                            size0,
                        ),
                    };
                    let (x, y) = (x.clamp(0.02, 0.98), y.clamp(0.02, 0.98));
                    match target {
                        Target::Title(id) => {
                            if let Some(title) = self.project.title_mut(id) {
                                (title.x, title.y, title.size) = (x, y, size);
                            }
                        }
                        _ => {
                            (
                                self.project.caption_x,
                                self.project.caption_bottom,
                                self.project.caption_size,
                            ) = (x, y.min(0.9), size);
                        }
                    }
                    self.edited();
                }
            }
        }
        if response.drag_stopped() {
            self.picture_drag = None;
        }
    }

    fn timeline_bar(&mut self, ui: &mut Ui) {
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 4.0;
            if icon_button(ui, Icon::Scissors, "Split at the playhead (S)", false).clicked() {
                self.split();
            }
            if icon_button(
                ui,
                Icon::Trash,
                "Delete (Delete; Shift+Delete closes the gap)",
                false,
            )
            .clicked()
            {
                let ripple = ui.input(|i| i.modifiers.shift);
                self.delete_selection(ripple);
            }
            if icon_button(
                ui,
                Icon::Magnet,
                "Snap to clips and the playhead (N)",
                self.timeline.snap,
            )
            .clicked()
            {
                self.timeline.snap = !self.timeline.snap;
            }
            if icon_button(ui, Icon::Plus, "Add a video track (Ctrl+T)", false).clicked() {
                self.history.record(&self.project);
                self.project.add_track(crate::project::TrackKind::Video);
                self.edited();
            }
            let label = if self.transcribing > 0 {
                "Making captions…"
            } else {
                "Make captions from speech, the selected clips or every clip with sound (Alt+C)"
            };
            if icon_button(ui, Icon::Captions, label, self.transcribing > 0).clicked()
                && self.transcribing == 0
            {
                self.make_captions();
            }
            if self.transcribing > 0 {
                ui.label(
                    egui::RichText::new("Making captions…")
                        .font(font::ui(12.0))
                        .color(color::INK_MUTED),
                );
            }
            if icon_button(ui, Icon::Text, "Add a title at the playhead (T)", false).clicked() {
                self.history.record(&self.project);
                let id = self.project.add_title(self.playhead);
                self.timeline.selection = vec![id];
                self.edited();
            }
            self.volume_control(ui);
            self.clip_settings(ui);
            self.caption_editor(ui);
            self.title_editor(ui);
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if icon_button(ui, Icon::ZoomIn, "Zoom in (+, or Ctrl+wheel)", false).clicked() {
                    self.timeline.pps = (self.timeline.pps * 1.5).min(600.0);
                }
                if icon_button(ui, Icon::ZoomOut, "Zoom out (−, or Ctrl+wheel)", false).clicked() {
                    self.timeline.pps = (self.timeline.pps / 1.5).max(2.0);
                }
            });
        });
    }

    /// Transcribes the selected clips with sound, or every clip with sound when none is selected.
    fn make_captions(&mut self) {
        let selected: Vec<_> = self
            .project
            .audible_clips()
            .into_iter()
            .filter(|(clip, _)| self.timeline.selection.contains(&clip.id))
            .collect();
        let clips = if selected.is_empty() {
            self.project.audible_clips()
        } else {
            selected
        };
        if clips.is_empty() {
            self.toasts
                .push("Add a clip with sound to make captions".into());
            return;
        }
        for (clip, media) in clips {
            self.worker.send(Job::Transcribe {
                clip: clip.id.clone(),
                path: media.path.clone(),
                from: clip.source_in,
                length: clip.source_length(),
                speed: clip.speed,
                at: clip.start,
            });
            self.transcribing += 1;
        }
        self.toasts.push(
            "Making captions; the first time takes a minute while the speech model loads".into(),
        );
    }

    /// One selected clip gets a menu for its fades, speed and, for pictures, how it sits in the frame and its color.
    fn clip_settings(&mut self, ui: &mut Ui) {
        let [id] = self.timeline.selection.as_slice() else {
            return;
        };
        let Some(clip) = self.project.clip(id).cloned() else {
            return;
        };
        let Some(kind) = self.project.media(&clip.media_id).map(|media| media.kind) else {
            return;
        };
        let id = id.clone();
        let mut changed = clip.clone();
        let longest = (clip.duration / 2.0).min(10.0);
        let media_path = self.project.media(&clip.media_id).map(|m| m.path.clone());
        let crossfade_limit = self.project.crossfade_limit(&id);
        let mut speed = clip.speed;
        ui.add_space(6.0);
        let mut find_scenes = false;
        let mut loudness = None;
        // Some(true) makes (or remakes) the clip's media's editing proxy, Some(false) deletes it.
        let mut proxy = None;
        let mut reframe = false;
        // Some(true) detaches the clip's sound onto an audio track, Some(false) unlinks it from its linked clip.
        let mut link = None;
        let has_sound = self
            .project
            .media(&clip.media_id)
            .is_some_and(|m| m.has_audio)
            && !self.project.sounds_elsewhere(&clip);
        // Some((true, s)) shows `s` more seconds of footage before the clip, Some((false, s)) after it.
        let mut extend = None;
        let mut ungroup = false;
        let mut more_speed = false;
        let focus_first = std::mem::take(&mut self.focus_clip_menu);
        let (menu_button, _) = egui::containers::menu::MenuButton::new(egui::RichText::new("Clip").font(font::ui(13.0))).config(stays_open()).ui(ui, |ui| {
            ui.set_min_width(230.0);
            ui.label(canopy_ui::muted("Tab and Shift+Tab move through this menu; arrows change a number."));
            if kind != MediaKind::Image {
                // A clip is a window on its whole video: it can always show more of what came before or after.
                ui.label(canopy_ui::muted("Show more of the video"));
                ui.horizontal(|ui| {
                    for (label, before, seconds) in [("5 s earlier", true, 5.0), ("1 s earlier", true, 1.0), ("1 s later", false, 1.0), ("5 s later", false, 5.0)] {
                        let hint = if before {
                            "Start this clip earlier in its video. At the start of the timeline, everything after it moves along to make room."
                        } else {
                            "End this clip later in its video. Clips right after it move along to make room."
                        };
                        if ui.button(label).on_hover_text(hint).clicked() {
                            extend = Some((before, seconds));
                        }
                    }
                });
                ui.separator();
            }
            if clip.group.is_some() {
                if ui.button("Ungroup layers").on_hover_text("Let this clip and the layers grouped with it move and trim on their own").clicked() {
                    ungroup = true;
                    ui.close();
                }
                ui.separator();
            }
            if self.project.linked(&clip.id).is_some() {
                if ui.button("Unlink").on_hover_text("Let this clip and its linked clip move and trim on their own").clicked() {
                    link = Some(false);
                    ui.close();
                }
                ui.separator();
            } else if kind == MediaKind::Video && has_sound {
                if ui.button("Detach sound").on_hover_text("Put its sound on an audio track as a clip of its own, linked to this one").clicked() {
                    link = Some(true);
                    ui.close();
                }
                ui.separator();
            }
            if has_sound {
                for (label, normalize, hint) in [
                    ("Measure loudness", false, "Its integrated loudness (EBU R128), as it plays"),
                    ("Normalize to -14 LUFS", true, "Set its volume so it plays at the loudness social apps use"),
                ] {
                    if ui.button(label).on_hover_text(hint).clicked() {
                        loudness = Some(normalize);
                        ui.close();
                    }
                }
                // The web StreamCuts' EQ and pan, in a submenu (the Clip menu is tall already).
                ui.menu_button("Sound: EQ and pan", |ui| {
                    ui.set_min_width(260.0);
                    let sound = &mut changed.sound;
                    ui.add(egui::Slider::new(&mut sound.pan, -1.0..=1.0).fixed_decimals(2).text("Pan, left to right"));
                    for (value, label) in [(&mut sound.low, "Low (120 Hz)"), (&mut sound.mid, "Mid (1 kHz)"), (&mut sound.high, "High (12 kHz)")] {
                        ui.add(egui::Slider::new(value, -12.0..=12.0).fixed_decimals(1).suffix(" dB").text(label));
                    }
                    if ui.add_enabled(!sound.is_neutral(), egui::Button::new("Reset")).clicked() {
                        *sound = Sound::default();
                    }
                });
                ui.separator();
            }
            if kind == MediaKind::Video {
                // As in the web StreamCuts' media menu: a small H.264 copy for smooth playback of heavy footage.
                let (making, has) = (self.proxy_jobs.contains(&clip.media_id), self.preview.proxies.contains_key(&clip.media_id));
                let label = if making { "Making proxy…" } else if has { "Rebuild editing proxy" } else { "Use editing proxy (smooth playback)" };
                if ui.add_enabled(!making, egui::Button::new(label))
                    .on_hover_text("Play this video from a 540p copy (made once, kept in the app's data folder); paused frames and exports use the original")
                    .clicked()
                {
                    proxy = Some(true);
                    ui.close();
                }
                if has && !making && ui.button("Delete editing proxy").on_hover_text("Play from the original again, and free the disk space").clicked() {
                    proxy = Some(false);
                    ui.close();
                }
                // As in the web StreamCuts (right-click a clip, Detect scenes): cuts in its video become timeline markers.
                let busy = self.scene_jobs.contains(&clip.media_id);
                if ui.add_enabled(!busy, egui::Button::new(if busy { "Finding scenes…" } else { "Detect scenes" }))
                    .on_hover_text("Mark where the picture cuts to another scene")
                    .clicked()
                {
                    find_scenes = true;
                    ui.close();
                }
                ui.separator();
            }
            egui::Grid::new("clip-settings").num_columns(2).spacing(vec2(10.0, 8.0)).show(ui, |ui| {
                ui.label("Fade in");
                let fade_in = ui.add(egui::DragValue::new(&mut changed.fade_in).range(0.0..=longest).speed(0.02).fixed_decimals(2).suffix(" s"));
                // Opened with Enter: the keyboard starts here.
                if focus_first {
                    fade_in.request_focus();
                }
                ui.end_row();
                ui.label("Fade out");
                ui.add(egui::DragValue::new(&mut changed.fade_out).range(0.0..=longest).speed(0.02).fixed_decimals(2).suffix(" s"));
                ui.end_row();
                if kind != MediaKind::Audio {
                    ui.label("Crossfade in");
                    ui.add(egui::DragValue::new(&mut changed.crossfade_in).range(0.0..=crossfade_limit).speed(0.02).fixed_decimals(2).suffix(" s"))
                        .on_hover_text("Blend from the previous clip on this track. Its unused source footage supplies the overlap.");
                    ui.end_row();
                    ui.label("Transition");
                    egui::ComboBox::from_id_salt("clip-transition").selected_text(changed.transition.label()).show_ui(ui, |ui| {
                        for transition in crate::project::Transition::ALL {
                            ui.selectable_value(&mut changed.transition, transition, transition.label());
                        }
                    }).response.on_hover_text("How the crossfade in looks");
                    ui.end_row();
                }
            });
            if kind != MediaKind::Image {
                ui.separator();
                ui.horizontal(|ui| {
                    ui.label("Speed");
                    ui.add(egui::DragValue::new(&mut speed).range(SPEEDS).speed(0.01).fixed_decimals(2).suffix("×"));
                    for preset in [0.5, 1.0, 2.0] {
                        if ui.selectable_label((speed - preset).abs() < 1e-6, format!("{preset}×")).clicked() {
                            speed = preset;
                        }
                    }
                    if ui.button("More…").on_hover_text("Change clip speed (Ctrl+S): exact speed or length, smooth slow motion, pitch, and moving what comes after").clicked() {
                        more_speed = true;
                        ui.close();
                    }
                });
            }
            if kind != MediaKind::Audio {
                ui.separator();
                ui.label(egui::RichText::new("In the frame").font(font::ui(12.0)).color(color::INK_MUTED));
                ui.horizontal(|ui| {
                    let fill = matches!(changed.framing, Framing::Fill { .. });
                    if ui.selectable_label(!fill, "Fit: all of it").clicked() {
                        changed.framing = Framing::Fit;
                    }
                    if ui.selectable_label(fill, "Fill: crop to the frame").clicked() && !fill {
                        changed.framing = Framing::Fill { x: 0.5, y: 0.5 };
                    }
                });
                if let Framing::Fill { x, y } = &mut changed.framing {
                    if changed.follow.is_empty() {
                        ui.add(egui::Slider::new(x, 0.0..=1.0).show_value(false).text("Left to right"));
                        ui.add(egui::Slider::new(y, 0.0..=1.0).show_value(false).text("Top to bottom"));
                    } else {
                        ui.label(canopy_ui::muted("The crop follows the action."));
                    }
                }
                // Moved, resized or cropped on the picture (`Place`): back to filling the frame.
                ui.horizontal(|ui| {
                    ui.label(canopy_ui::muted("On the picture: drag to move, corners to resize, edges to crop."));
                });
                if !changed.place.is_full() && ui.button("Reset size, place and crop").clicked() {
                    changed.place = crate::project::Placement::default();
                }
                // The web StreamCuts' auto-reframe: fill the frame and keep the crop on where things move.
                if kind == MediaKind::Video {
                    let busy = self.focus_jobs.contains(&clip.id);
                    let label = if busy { "Following the action…" } else if changed.follow.is_empty() { "Auto-reframe" } else { "Auto-reframe again" };
                    ui.horizontal(|ui| {
                        if ui.add_enabled(!busy, egui::Button::new(label))
                            .on_hover_text("Fill the frame, the crop following where things move (wide video into a vertical short)")
                            .clicked()
                        {
                            reframe = true;
                            ui.close();
                        }
                        if !changed.follow.is_empty() && ui.button("Stop following").clicked() {
                            changed.follow.clear();
                        }
                    });
                }
                ui.separator();
                // Color and effects get submenus of their own: together they're taller than a laptop screen.
                let color_label = if changed.grade.is_neutral() && changed.lut.is_none() { "Color" } else { "Color (changed)" };
                ui.menu_button(color_label, |ui| {
                    ui.set_min_width(250.0);
                    // A .cube LUT, as the web StreamCuts' color page takes: a camera's log-to-normal LUT, or a look.
                    ui.horizontal(|ui| {
                        let name = changed.lut.as_ref().and_then(|p| p.file_name()).map_or("Add a LUT…".into(), |n| n.to_string_lossy().into_owned());
                        let missing = changed.lut.as_ref().is_some_and(|p| !p.is_file());
                        let button = ui.button(if missing { format!("{name} (missing)") } else { name })
                            .on_hover_text("A .cube color lookup table, applied before the color below");
                        if button.clicked() {
                            if let Some(path) = rfd::FileDialog::new().set_title("Choose a LUT").add_filter("Cube LUT", &["cube"]).pick_file() {
                                changed.lut = Some(path);
                            }
                        }
                        if changed.lut.is_some() && ui.small_button("Remove").clicked() {
                            changed.lut = None;
                        }
                    });
                    ui.separator();
                    ui.horizontal(|ui| {
                        ui.label(egui::RichText::new("Color").font(font::ui(12.0)).color(color::INK_MUTED));
                        if !changed.grade.is_neutral() && ui.small_button("Reset").clicked() {
                            changed.grade = Grade::default();
                        }
                    });
                    ui.add(egui::Slider::new(&mut changed.grade.brightness, -0.5..=0.5).show_value(false).text("Brightness"));
                    ui.add(egui::Slider::new(&mut changed.grade.contrast, 0.5..=2.0).show_value(false).text("Contrast"));
                    ui.add(egui::Slider::new(&mut changed.grade.saturation, 0.0..=2.5).show_value(false).text("Saturation"));
                    ui.horizontal(|ui| {
                        let wheels = &mut changed.grade.wheels;
                        color_wheel(ui, "Lift", &mut wheels.lift);
                        color_wheel(ui, "Gamma", &mut wheels.gamma);
                        color_wheel(ui, "Gain", &mut wheels.gain);
                    });
                });
                ui.menu_button(if changed.effects.is_neutral() { "Effects" } else { "Effects (changed)" }, |ui| {
                    ui.set_min_width(250.0);
                    ui.horizontal(|ui| {
                        ui.label(egui::RichText::new("Effects").font(font::ui(12.0)).color(color::INK_MUTED));
                        if !changed.effects.is_neutral() && ui.small_button("Reset").clicked() {
                            changed.effects = Effects::default();
                        }
                    });
                    ui.add(egui::Slider::new(&mut changed.effects.blur, 0.0..=12.0).text("Blur"));
                    ui.add(egui::Slider::new(&mut changed.effects.sharpen, 0.0..=2.0).text("Sharpen"));
                    egui::ComboBox::from_label("Look").selected_text(changed.effects.look.map_or("None", |l| l.label())).show_ui(ui, |ui| {
                        ui.selectable_value(&mut changed.effects.look, None, "None");
                        for look in crate::project::Look::ALL {
                            ui.selectable_value(&mut changed.effects.look, Some(look), look.label());
                        }
                    });
                    // The web StreamCuts' Curves, in a submenu (the Clip menu is tall already).
                    ui.menu_button("Curves", |ui| {
                        let curves = &mut changed.effects.curves;
                        let which = ui.scope_id().with("curve-channel");
                        let mut channel = ui.data(|d| d.get_temp::<usize>(which)).unwrap_or(0);
                        ui.horizontal(|ui| {
                            for (i, name) in ["All", "Red", "Green", "Blue"].into_iter().enumerate() {
                                if ui.selectable_label(channel == i, name).clicked() {
                                    channel = i;
                                }
                            }
                        });
                        ui.data_mut(|d| d.insert_temp(which, channel));
                        let (points, ink) = match channel {
                            1 => (&mut curves.red, Color32::from_rgb(255, 100, 100)),
                            2 => (&mut curves.green, Color32::from_rgb(100, 230, 120)),
                            3 => (&mut curves.blue, Color32::from_rgb(120, 160, 255)),
                            _ => (&mut curves.master, color::INK),
                        };
                        curve_editor(ui, points, ink);
                        if ui.add_enabled(*curves != crate::project::Curves::default(), egui::Button::new("Reset all curves")).clicked() {
                            *curves = crate::project::Curves::default();
                        }
                    });
                });
            }
        });
        if changed != clip || speed != clip.speed {
            // One undo step per drag or click.
            if !self.adjusting {
                self.history.record(&self.project);
                self.adjusting = true;
            }
            if let Some(target) = self.project.clip_mut(&id) {
                *target = changed;
            }
            if clip.crossfade_in != self.project.clip(&id).unwrap().crossfade_in {
                let seconds = self.project.clip(&id).unwrap().crossfade_in;
                self.project.set_crossfade(&id, seconds);
            }
            if speed != clip.speed {
                self.project.set_speed(&id, speed);
            }
            self.edited();
        }
        if !ui.input(|i| i.pointer.any_down()) {
            self.adjusting = false;
        }
        // Enter (the ClipMenu command) opens the menu; the next frame puts the keyboard on its first field.
        if std::mem::take(&mut self.open_clip_menu) {
            egui::Popup::open_id(ui.ctx(), egui::Popup::default_response_id(&menu_button));
            self.focus_clip_menu = true;
        }
        let _ = media_path;
        let ops = [
            proxy.map(ClipOp::Proxy),
            loudness.map(ClipOp::Loudness),
            find_scenes.then_some(ClipOp::Scenes),
            reframe.then_some(ClipOp::Reframe),
            link.map(ClipOp::Link),
            extend.map(|(before, seconds)| ClipOp::Extend(before, seconds)),
            ungroup.then_some(ClipOp::Ungroup),
        ];
        for op in ops.into_iter().flatten() {
            self.clip_op(&clip.id, op);
        }
        if more_speed {
            let ctx = ui.ctx().clone();
            self.run(Cmd::ChangeSpeed, &ctx);
        }
    }

    /// One selected title gets its text, and a menu for its size, height and length, in the timeline bar.
    fn title_editor(&mut self, ui: &mut Ui) {
        let [id] = self.timeline.selection.as_slice() else {
            return;
        };
        let Some(title) = self.project.titles.iter().find(|t| &t.id == id).cloned() else {
            return;
        };
        let id = id.clone();
        let mut changed = title.clone();
        ui.add_space(10.0);
        let field = ui.add(
            egui::TextEdit::singleline(&mut changed.text)
                .desired_width(ui.available_width().clamp(100.0, 260.0) - 60.0)
                .hint_text("Title"),
        );
        egui::containers::menu::MenuButton::new(
            egui::RichText::new("Size & place").font(font::ui(13.0)),
        )
        .config(stays_open())
        .ui(ui, |ui| {
            ui.set_min_width(240.0);
            ui.add(
                egui::Slider::new(&mut changed.size, 0.03..=0.25)
                    .show_value(false)
                    .text("Size"),
            );
            ui.horizontal(|ui| {
                for (label, y) in [("Top", 0.15), ("Middle", 0.5), ("Bottom", 0.82)] {
                    if ui
                        .selectable_label((changed.y - y).abs() < 0.01, label)
                        .clicked()
                    {
                        changed.y = y;
                    }
                }
            });
            ui.add(
                egui::Slider::new(&mut changed.y, 0.05..=0.95)
                    .show_value(false)
                    .text("Height"),
            );
            let mut length = changed.end - changed.start;
            if ui
                .add(
                    egui::DragValue::new(&mut length)
                        .range(0.5..=600.0)
                        .speed(0.05)
                        .fixed_decimals(1)
                        .prefix("Shows for ")
                        .suffix(" s"),
                )
                .changed()
            {
                changed.end = changed.start + length;
            }
        });
        if changed != title {
            // One undo step per drag, click or stretch of typing.
            if !self.adjusting {
                self.history.record(&self.project);
                self.adjusting = true;
            }
            if let Some(target) = self.project.title_mut(&id) {
                *target = changed;
            }
            self.edited();
        }
        if !ui.input(|i| i.pointer.any_down()) && !field.has_focus() {
            self.adjusting = false;
        }
    }

    /// One selected caption gets its text in the timeline bar, to fix what the transcription heard.
    fn caption_editor(&mut self, ui: &mut Ui) {
        let [id] = self.timeline.selection.as_slice() else {
            return;
        };
        let Some(index) = self.project.captions.iter().position(|c| &c.id == id) else {
            return;
        };
        let mut text = self.project.captions[index].text.clone();
        ui.add_space(10.0);
        let field = ui.add(
            egui::TextEdit::singleline(&mut text)
                .desired_width(ui.available_width().clamp(120.0, 420.0) - 80.0)
                .hint_text("Caption"),
        );
        if field.changed() {
            if field.gained_focus() || !self.caption_typing {
                self.history.record(&self.project);
                self.caption_typing = true;
            }
            self.project.captions[index].text = text;
            // Word timings no longer match edited text; captions show as whole lines.
            self.project.captions[index].words.clear();
            self.edited();
        }
        if field.lost_focus() {
            self.caption_typing = false;
        }
        let mut words = self.project.caption_words;
        if ui
            .checkbox(&mut words, "Word by word")
            .on_hover_text("Light up each word as it's said (captions made from speech)")
            .changed()
        {
            self.history.record(&self.project);
            self.project.caption_words = words;
            self.edited();
        }
    }

    /// One selected clip with sound gets a volume slider in the timeline bar.
    fn volume_control(&mut self, ui: &mut Ui) {
        let [id] = self.timeline.selection.as_slice() else {
            return;
        };
        let Some(clip) = self.project.clip(id) else {
            return;
        };
        if !self
            .project
            .media(&clip.media_id)
            .is_some_and(|media| media.has_audio)
            || self.project.sounds_elsewhere(clip)
        {
            return;
        }
        let (id, before) = (id.clone(), clip.volume);
        let mut percent = (before * 100.0).round();
        ui.add_space(10.0);
        icon(
            ui.painter(),
            Rect::from_center_size(ui.cursor().min + vec2(8.0, 15.0), vec2(14.0, 14.0)),
            Icon::Audio,
            color::INK_SOFT,
        );
        ui.add_space(20.0);
        let slider = ui
            .add(
                egui::Slider::new(&mut percent, 0.0..=200.0)
                    .suffix("%")
                    .step_by(1.0),
            )
            .on_hover_text("The clip's volume");
        // One undo step per drag, not one per frame of it.
        if slider.drag_started() || (slider.changed() && !slider.dragged()) {
            self.history.record(&self.project);
        }
        if slider.changed() {
            if let Some(clip) = self.project.clip_mut(&id) {
                clip.volume = percent / 100.0;
            }
            self.edited();
        }
    }

    fn projects_window(&mut self, ui: &mut Ui) {
        if !self.show_projects {
            return;
        }
        let mut open = None;
        let mut new = false;
        let modal = egui::Modal::new(ui.scope_id().with("projects")).show(ui.ctx(), |ui| {
            ui.set_width(360.0);
            ui.label(egui::RichText::new("Your projects").font(font::display(20.0)));
            ui.add_space(8.0);
            if quiet_button(ui, "New project", Some(Icon::Plus)).clicked() {
                new = true;
            }
            ui.add_space(6.0);
            for doc in storage::list(&self.place.projects_dir) {
                let current = storage::file_for(&self.place.projects_dir, &self.project)
                    .file_name()
                    .map(|n| n.to_string_lossy() == doc.id)
                    .unwrap_or(false);
                let row = canopy_ui::Row {
                    title: &doc.name,
                    detail: &doc.detail,
                    mark: canopy_ui::RowMark::Icon(Icon::Project),
                    highlighted: current,
                }
                .show(ui);
                if row.clicked() {
                    open = Some(doc.id.clone());
                }
                ui.add_space(4.0);
            }
        });
        if modal.should_close() {
            self.show_projects = false;
        }
        if new {
            self.open(Project::new("Untitled cut"));
            self.show_projects = false;
        }
        if let Some(id) = open {
            if let Ok(project) = storage::load(&self.place.projects_dir.join(&id)) {
                self.open(project);
            }
            self.show_projects = false;
        }
    }

    /// Starts the next waiting render when nothing is rendering.
    fn render_next(&mut self, ctx: &egui::Context) {
        if self.export.is_some() {
            return;
        }
        let Some(job) = self.queue.iter_mut().find(|q| q.status == Status::Waiting) else {
            return;
        };
        if let Some(media) = job.project.missing_media().first() {
            job.status = Status::Failed(format!("{} is missing", media.name));
            return;
        }
        let _ = std::fs::create_dir_all(&self.place.exports_dir);
        let name = canopy_ui::canopy_core::files::unique_name(
            &self.place.exports_dir,
            &format!("{}.{}", job.name, job.project.export_format.extension()),
        );
        let output = self.place.exports_dir.join(name);
        match export::start(&job.project, &output, ctx.clone()) {
            Ok(run) => {
                self.export = Some(run);
                self.rendering = Some(job.id.clone());
                job.status = Status::Rendering(output);
            }
            Err(error) => job.status = Status::Failed(error),
        }
    }

    /// The Deliver window: presets to queue, your own saved, and the render queue.
    fn deliver_window(&mut self, ui: &mut Ui) {
        if !self.show_deliver {
            return;
        }
        let mut open = true;
        let (mut queue, mut forget, mut remove, mut stop, mut save) =
            (None, None, None, false, false);
        let progress = self
            .export
            .as_ref()
            .filter(|_| self.rendering.is_some())
            .map_or(0.0, |run| {
                run.progress.load(Ordering::Relaxed) as f32 / 1000.0
            });
        egui::Window::new("Deliver")
            .open(&mut open)
            .collapsible(false)
            .resizable(false)
            .default_width(380.0)
            .constrain_to(ui.max_rect())
            .show(ui.ctx(), |ui| {
                ui.label(
                    egui::RichText::new("Presets")
                        .font(font::ui(12.0))
                        .color(color::INK_MUTED),
                );
                let built_in = Preset::built_in();
                egui::Grid::new("presets")
                    .num_columns(3)
                    .spacing(vec2(8.0, 6.0))
                    .show(ui, |ui| {
                        for (mine, preset) in built_in
                            .iter()
                            .map(|p| (false, p))
                            .chain(self.presets.iter().map(|p| (true, p)))
                        {
                            if ui.small_button("Queue").clicked() {
                                queue = Some(preset.clone());
                            }
                            ui.label(&preset.name).on_hover_text(preset.describe());
                            ui.horizontal(|ui| {
                                ui.label(canopy_ui::muted(preset.describe()));
                                if mine
                                    && ui
                                        .small_button("×")
                                        .on_hover_text("Delete this preset")
                                        .clicked()
                                {
                                    forget = Some(preset.name.clone());
                                }
                            });
                            ui.end_row();
                        }
                    });
                ui.horizontal(|ui| {
                    ui.add(
                        egui::TextEdit::singleline(&mut self.preset_name)
                            .hint_text("Name these settings")
                            .desired_width(180.0),
                    );
                    save = ui
                        .add_enabled(
                            !self.preset_name.trim().is_empty(),
                            egui::Button::new("Save as preset"),
                        )
                        .on_hover_text(Preset::of(&self.project, "").describe())
                        .clicked();
                });
                ui.separator();
                ui.label(
                    egui::RichText::new("Render queue")
                        .font(font::ui(12.0))
                        .color(color::INK_MUTED),
                );
                if self.queue.is_empty() {
                    ui.label(canopy_ui::muted(
                        "Queue a preset: renders run one after another, into this space's files.",
                    ));
                }
                for job in &self.queue {
                    ui.horizontal(|ui| {
                        ui.label(&job.name);
                        match &job.status {
                            Status::Waiting => {
                                ui.label(canopy_ui::muted("waiting"));
                            }
                            Status::Rendering(_) => {
                                ui.add(
                                    egui::ProgressBar::new(progress)
                                        .desired_width(110.0)
                                        .show_percentage(),
                                );
                                stop |= ui.small_button("Stop").clicked();
                            }
                            Status::Done(path) => {
                                ui.label(canopy_ui::muted("done"))
                                    .on_hover_text(path.display().to_string());
                            }
                            Status::Failed(error) => {
                                ui.label(egui::RichText::new("failed").color(color::SUN))
                                    .on_hover_text(error);
                            }
                        }
                        if !matches!(job.status, Status::Rendering(_))
                            && ui
                                .small_button("×")
                                .on_hover_text("Take it off the queue")
                                .clicked()
                        {
                            remove = Some(job.id.clone());
                        }
                    });
                }
            });
        self.show_deliver = open;
        if let Some(preset) = queue {
            self.queue.push(Queued::new(&self.project, &preset));
        }
        if save {
            let preset = Preset::of(&self.project, &self.preset_name);
            self.presets.retain(|p| p.name != preset.name);
            self.presets.push(preset);
            self.preset_name.clear();
            if let Err(error) = Preset::save(&self.place.data_dir, &self.presets) {
                self.toasts.push(error);
            }
        }
        if let Some(name) = forget {
            self.presets.retain(|p| p.name != name);
            if let Err(error) = Preset::save(&self.place.data_dir, &self.presets) {
                self.toasts.push(error);
            }
        }
        if let Some(id) = remove {
            self.queue.retain(|q| q.id != id);
        }
        if let (true, Some(run)) = (stop, &self.export) {
            run.cancel.store(true, Ordering::Relaxed);
        }
    }

    fn export_window(&mut self, ui: &mut Ui, host: &mut dyn Host) {
        let Some(run) = &self.export else { return };
        // A queued render reports in the Deliver window, and the editor stays usable meanwhile.
        if let Some(id) = self.rendering.clone() {
            if let Ok(result) = run.result.try_recv() {
                self.export = None;
                self.rendering = None;
                if let Some(job) = self.queue.iter_mut().find(|q| q.id == id) {
                    let output = match &job.status {
                        Status::Rendering(path) => Some(path.clone()),
                        _ => None,
                    };
                    job.status = match (result, output) {
                        (Ok(()), Some(path)) => {
                            host.exported(path.clone());
                            Status::Done(path)
                        }
                        (Err(error), _) => Status::Failed(error),
                        (Ok(()), None) => Status::Failed("Lost track of the file".into()),
                    };
                }
            }
            return;
        }
        if let Ok(result) = run.result.try_recv() {
            let path = self.exported.pop();
            self.export = None;
            match (result, path) {
                (Ok(()), Some(path)) => host.exported(path),
                (Err(error), _) => host.toast(error),
                _ => {}
            }
            return;
        }
        let progress = run.progress.load(Ordering::Relaxed) as f32 / 1000.0;
        let mut cancel = false;
        egui::Modal::new(ui.scope_id().with("export")).show(ui.ctx(), |ui| {
            ui.set_width(340.0);
            ui.label(egui::RichText::new("Exporting").font(font::display(20.0)));
            ui.label(canopy_ui::muted(format!(
                "{} · {}×{} · {} fps",
                self.project.name, self.project.width, self.project.height, self.project.fps
            )));
            ui.add_space(8.0);
            ui.add(egui::ProgressBar::new(progress).show_percentage());
            ui.add_space(8.0);
            cancel = quiet_button(ui, "Stop", None).clicked();
        });
        if cancel {
            run.cancel.store(true, Ordering::Relaxed);
        }
    }
}

impl CanopyApp for StreamCuts {
    fn ui(&mut self, ui: &mut Ui, host: &mut dyn Host) {
        let ctx = ui.ctx().clone();
        self.pane = ui.max_rect();
        self.drain_worker(&ctx);
        self.codex_poll();
        for toast in self.toasts.drain(..) {
            host.toast(toast);
        }
        self.shortcuts(ui, host.focused());
        if self.clock.playing {
            if self.audio.update(&self.project, self.playhead) {
                self.playhead = self.audio.now().unwrap_or_else(|| self.clock.now());
                if self.playhead >= self.project.duration() {
                    self.playhead = self.project.duration();
                    self.pause();
                }
            } else {
                // The sound stopped while StreamCuts was out of sight: stop the picture where the sound stopped.
                self.playhead = self
                    .audio
                    .now()
                    .unwrap_or(self.playhead)
                    .min(self.project.duration());
                self.pause();
            }
            ctx.request_repaint();
        }
        self.preview.update(
            &ctx,
            &self.project,
            self.playhead,
            self.clock.playing,
            &self.worker,
        );
        // Tracks that show below a moved, resized or cropped clip get previews of their own.
        let below: Vec<usize> = self
            .project
            .layers_at(self.playhead)
            .into_iter()
            .skip(1)
            .collect();
        self.under.retain(|track, _| below.contains(track));
        for track in below {
            let layer = self
                .under
                .entry(track)
                .or_insert_with(|| crate::preview::Preview::of_track(track));
            layer.proxies.clone_from(&self.preview.proxies);
            layer.update(
                &ctx,
                &self.project,
                self.playhead,
                self.clock.playing,
                &self.worker,
            );
        }
        if self
            .edited_at
            .is_some_and(|at| at.elapsed() > Duration::from_millis(800))
        {
            if let Err(error) = self.save() {
                host.toast(format!("Couldn't save: {error}"));
            }
        } else if self.edited_at.is_some() {
            ctx.request_repaint_after(Duration::from_millis(850));
        }

        let rect = ui.max_rect();
        let toolbar = Rect::from_min_size(rect.min, vec2(rect.width(), 40.0));
        ui.scope_builder(
            UiBuilder::new().max_rect(toolbar.shrink2(vec2(8.0, 4.0))),
            |ui| self.toolbar(ui),
        );
        let body_top = toolbar.bottom() + 4.0;
        let timeline_height = ((rect.height() - 44.0) * 0.42).max(160.0);
        let upper = Rect::from_min_max(
            pos2(rect.left(), body_top),
            pos2(rect.right(), rect.bottom() - timeline_height - 6.0),
        );
        let bin = Rect::from_min_size(
            upper.min,
            vec2((rect.width() * 0.2).clamp(150.0, BIN_WIDTH), upper.height()),
        );
        // Codex's panel, when it's open, is a column at the right of the preview, like the bin at its left.
        let codex = self.codex.open.then(|| {
            Rect::from_min_max(pos2(upper.right() - (rect.width() * 0.3).clamp(300.0, 420.0), upper.top()), upper.max)
        });
        let preview = Rect::from_min_max(
            pos2(bin.right() + 6.0, upper.top()),
            pos2(codex.map_or(upper.right(), |c| c.left() - 6.0), upper.bottom()),
        );
        ui.painter().add(pane_frame(Mood::Ember).paint(bin));
        if let Some(column) = codex {
            ui.painter().add(pane_frame(Mood::Ember).paint(column));
        }
        ui.scope_builder(UiBuilder::new().max_rect(bin.shrink(8.0)), |ui| {
            self.media_bin(ui)
        });
        ui.scope_builder(UiBuilder::new().max_rect(preview), |ui| self.preview(ui));

        let lower =
            Rect::from_min_max(pos2(rect.left(), rect.bottom() - timeline_height), rect.max);
        ui.painter().rect_filled(lower, 10, Mood::Ember.pane());
        ui.painter().rect_stroke(
            lower,
            10,
            egui::Stroke::new(1.0, color::HAIRLINE),
            egui::StrokeKind::Inside,
        );
        let bar = Rect::from_min_size(lower.min + vec2(8.0, 4.0), vec2(lower.width() - 16.0, 32.0));
        ui.scope_builder(UiBuilder::new().max_rect(bar), |ui| self.timeline_bar(ui));
        let lanes = Rect::from_min_max(
            pos2(lower.left() + 4.0, bar.bottom() + 4.0),
            lower.max - vec2(4.0, 4.0),
        );
        let output = ui
            .scope_builder(UiBuilder::new().max_rect(lanes), |ui| {
                self.timeline.ui(
                    ui,
                    &mut self.project,
                    &mut self.history,
                    self.playhead,
                    &self.looks,
                )
            })
            .inner;
        self.lanes_width = lanes.width();
        if self.clock.playing {
            self.timeline.follow(self.playhead, lanes.width());
        }
        if output.changed {
            self.edited();
        }
        if let Some(t) = output.seek {
            self.seek(t);
        }
        if let Some(choice) = output.menu {
            match choice.cmd {
                Cmd::GrabFrame => self.grab_frame(Some(choice.clip), Some(choice.at)),
                Cmd::EditInFolio => self.to_folio = Some(choice.clip),
                cmd => self.run(cmd, ui.ctx()),
            }
        }
        if let Some(clip) = self.to_folio.take() {
            self.edit_in_folio(&clip, host);
        }
        if let Some((files, at, track)) = output.dropped {
            self.import(
                files
                    .into_iter()
                    .filter(|f| accepts(f))
                    .map(|f| f.path)
                    .collect(),
                at,
                track,
                true,
            );
        }
        self.projects_window(ui);
        // Codex's panel goes in last, so nothing laid over the whole editor (drops, the timeline) takes its clicks.
        if let Some(column) = codex {
            ui.scope_builder(UiBuilder::new().max_rect(column.shrink(10.0)), |ui| self.codex_panel(ui));
        }
        self.boss_window(ui);
        self.render_next(&ctx);
        self.deliver_window(ui);
        self.export_window(ui, host);
        self.commands_window(ui);
        self.speed_window(ui);
    }

    fn receive(&mut self, files: Vec<SharedFile>, _host: &mut dyn Host) -> Receipt {
        let mut receipt = Receipt::default();
        let mut media = Vec::new();
        for file in files {
            if file.name.to_lowercase().ends_with(storage::EXTENSION) {
                match storage::load(&file.path) {
                    Ok(project) => {
                        self.open(project);
                        receipt.accepted += 1;
                    }
                    Err(_) => receipt.skipped.push(file.name),
                }
            } else if accepts(&file) {
                media.push(file.path);
                receipt.accepted += 1;
            } else {
                receipt.skipped.push(file.name);
            }
        }
        // Sent files land at the playhead, like pasting in StreamCuts on the web.
        self.import(media, self.playhead, None, false);
        receipt
    }

    fn open_document(&mut self, id: &str, host: &mut dyn Host) {
        if let Some(json) = id.strip_prefix(EDITED_PICTURE) {
            match self.take_edited_picture(json) {
                Ok(text) | Err(text) => host.toast(text),
            }
            return;
        }
        match storage::load(&self.place.projects_dir.join(id)) {
            Ok(project) => self.open(project),
            Err(error) => host.toast(error),
        }
    }

    fn save(&mut self) -> Result<(), String> {
        self.edited_at = None;
        if self.project.duration() == 0.0 && self.project.media.is_empty() {
            return Ok(()); // An untouched new project isn't worth a file.
        }
        storage::save(&self.place.projects_dir, &mut self.project).map(|_| ())
    }

    fn title(&self) -> String {
        self.project.name.clone()
    }
}

/// What Folio is sent to edit a picture, and what it sends back (see Folio's `PictureRequest`).
const EDIT_PICTURE: &str = "edit-picture:";
const EDITED_PICTURE: &str = "edited-picture:";

/// A still picture Folio can open: PNG, JPEG or WebP, not animated.
pub fn folio_can_edit(media: &crate::project::Media) -> bool {
    let ext = media.path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    media.kind == MediaKind::Image && media.loop_length().is_none() && ["png", "jpg", "jpeg", "webp"].contains(&ext.as_str())
}

/// Video, pictures and sound.
pub fn accepts(file: &SharedFile) -> bool {
    matches!(file.kind, Kind::Video | Kind::Image | Kind::Audio)
        || file.name.to_lowercase().ends_with(storage::EXTENSION)
}

/// A color wheel, like the web StreamCuts' trackballs: drag its dot towards a hue to push the picture that way
/// (double-click to center it), with the wheel's master level under it.
fn color_wheel(ui: &mut Ui, label: &str, wheel: &mut crate::project::Wheel) {
    // The push at the rim, and where each primary sits: red up, green and blue a third of a turn either side.
    const AMOUNT: f32 = 0.5;
    let dir = |c: usize| {
        let a = [90.0f32, 210.0, 330.0][c].to_radians();
        vec2(a.cos(), a.sin())
    };
    ui.vertical(|ui| {
        ui.label(
            egui::RichText::new(label)
                .font(font::ui(11.0))
                .color(color::INK_MUTED),
        );
        let (rect, response) = ui.allocate_exact_size(vec2(64.0, 64.0), Sense::click_and_drag());
        let (center, radius) = (rect.center(), rect.width() / 2.0);
        // Gray in the middle, and at the rim the color a push that way gives.
        let mut disc = egui::Mesh::default();
        disc.colored_vertex(center, Color32::from_gray(128));
        let steps = 48;
        for i in 0..=steps {
            let a = i as f32 / steps as f32 * std::f32::consts::TAU;
            let p = vec2(a.cos(), a.sin());
            let [r, g, b] =
                [0, 1, 2].map(|c| (127.5 + 127.5 * p.dot(dir(c))).clamp(0.0, 255.0) as u8);
            disc.colored_vertex(
                center + vec2(p.x, -p.y) * radius,
                Color32::from_rgb(r, g, b),
            );
            if i > 0 {
                disc.add_triangle(0, i, i + 1);
            }
        }
        ui.painter().add(disc);
        if response.double_clicked() {
            (wheel.r, wheel.g, wheel.b) = (0.0, 0.0, 0.0);
        } else if response.dragged() || response.clicked() {
            if let Some(pos) = response.interact_pointer_pos() {
                let p = (pos - center) / radius;
                let p = vec2(p.x, -p.y);
                let p = if p.length() > 1.0 { p.normalized() } else { p };
                [wheel.r, wheel.g, wheel.b] = [0, 1, 2].map(|c| AMOUNT * p.dot(dir(c)));
            }
        }
        // The dot: where the push points (the inverse of the above on pushes that add up to 0).
        let dot = (0..3).fold(egui::Vec2::ZERO, |sum, c| {
            sum + dir(c) * [wheel.r, wheel.g, wheel.b][c]
        }) * (2.0 / 3.0 / AMOUNT);
        ui.painter().circle(
            center + vec2(dot.x, -dot.y) * radius,
            4.5,
            Color32::WHITE,
            egui::Stroke::new(1.5, Color32::BLACK),
        );
        response.on_hover_text("Drag towards a color; double-click to center");
        ui.add(
            egui::DragValue::new(&mut wheel.master)
                .range(-0.5..=0.5)
                .speed(0.005)
                .fixed_decimals(2),
        )
        .on_hover_text(format!("{label} for all colors"));
    });
}

/// A tone curve to bend: drag one of its five points up or down (double-click puts it back on the line).
fn curve_editor(ui: &mut Ui, points: &mut [f32; 5], ink: Color32) {
    use crate::project::{CURVE_KNOTS, curve_at};
    let (rect, _) = ui.allocate_exact_size(vec2(200.0, 200.0), Sense::hover());
    let painter = ui.painter();
    painter.rect_filled(rect, 4, Color32::from_black_alpha(120));
    let at = |x: f32, y: f32| {
        pos2(
            rect.left() + x * rect.width(),
            rect.bottom() - y * rect.height(),
        )
    };
    for q in [0.25, 0.5, 0.75] {
        painter.line_segment(
            [at(q, 0.0), at(q, 1.0)],
            egui::Stroke::new(1.0, color::HAIRLINE),
        );
        painter.line_segment(
            [at(0.0, q), at(1.0, q)],
            egui::Stroke::new(1.0, color::HAIRLINE),
        );
    }
    painter.line_segment(
        [at(0.0, 0.0), at(1.0, 1.0)],
        egui::Stroke::new(1.0, color::HAIRLINE_STRONG),
    );
    let line: Vec<egui::Pos2> = (0..=80)
        .map(|i| i as f32 / 80.0)
        .map(|x| at(x, curve_at(points, x)))
        .collect();
    painter.add(egui::Shape::line(line, egui::Stroke::new(2.0, ink)));
    for (i, x) in CURVE_KNOTS.into_iter().enumerate() {
        let handle = Rect::from_center_size(at(x, points[i]), vec2(16.0, 16.0));
        let response = ui
            .interact(
                handle,
                ui.scope_id().with(("curve-point", i)),
                Sense::click_and_drag(),
            )
            .on_hover_cursor(egui::CursorIcon::ResizeVertical);
        if response.double_clicked() {
            points[i] = x;
        } else if response.dragged() {
            if let Some(pointer) = response.interact_pointer_pos() {
                points[i] = ((rect.bottom() - pointer.y) / rect.height()).clamp(0.0, 1.0);
            }
        }
        let hot = response.hovered() || response.dragged();
        ui.painter().circle(
            at(x, points[i]),
            if hot { 6.0 } else { 4.5 },
            ink,
            egui::Stroke::new(1.5, Color32::BLACK),
        );
    }
}

/// A five-pointed star filling a circle of `radius` around `center`.
fn star(painter: &egui::Painter, center: egui::Pos2, radius: f32, fill: Color32) {
    let mut mesh = egui::Mesh::default();
    mesh.colored_vertex(center, fill);
    for i in 0..=10u32 {
        let angle = -std::f32::consts::FRAC_PI_2 + i as f32 * std::f32::consts::PI / 5.0;
        let reach = if i % 2 == 0 { radius } else { radius * 0.45 };
        mesh.colored_vertex(center + vec2(angle.cos(), angle.sin()) * reach, fill);
        if i > 0 {
            mesh.add_triangle(0, i, i + 1);
        }
    }
    painter.add(mesh);
}

/// For menus you work in: egui closes a menu on any click inside it, which would close the Clip menu on every value,
/// tab and field. These close on a click outside, and their actions close them themselves.
fn stays_open() -> egui::containers::menu::MenuConfig {
    egui::containers::menu::MenuConfig::new()
        .close_behavior(egui::PopupCloseBehavior::CloseOnClickOutside)
}

#[cfg(test)]
mod keyboard_tests {
    use super::*;
    use crate::project::{Attributes, Media, TrackKind};

    struct TestHost(Vec<String>);
    impl Host for TestHost {
        fn toast(&mut self, text: String) {
            self.0.push(text);
        }
        fn exported(&mut self, _: PathBuf) {}
    }

    fn key(key: Key, modifiers: Modifiers) -> Vec<egui::Event> {
        vec![egui::Event::Key { key, physical_key: None, pressed: true, repeat: false, modifiers }]
    }

    fn frame(app: &mut StreamCuts, ctx: &egui::Context, host: &mut TestHost, events: Vec<egui::Event>) {
        let input = egui::RawInput {
            screen_rect: Some(Rect::from_min_size(pos2(0.0, 0.0), vec2(1400.0, 900.0))),
            events,
            ..Default::default()
        };
        ctx.run_ui(input, |ui| app.ui(ui, host)).textures_delta.clear();
    }

    fn start(app: &StreamCuts, id: &str) -> f64 {
        app.project.clip(id).unwrap().start
    }

    #[test]
    fn the_whole_edit_works_from_the_keyboard() {
        let dir = std::env::temp_dir().join(format!("streamcuts-keys-{}", std::process::id()));
        let place = Place {
            space: None,
            projects_dir: dir.join("projects"),
            data_dir: dir.join("data"),
            exports_dir: dir.join("exports"),
        };
        let ctx = egui::Context::default();
        let mut app = StreamCuts::new(place, &ctx);
        let mut project = Project::new("Keys");
        let media = project.add_media(Media {
            id: "m".into(),
            path: dir.join("missing.mp4"),
            name: "m".into(),
            kind: MediaKind::Video,
            duration: 4.0,
            width: 1920,
            height: 1080,
            has_audio: true,
            frame_rate: 30.0,
            attributes: Attributes::default(),
        });
        let first = project.place(&media, Some(0), 0.0).unwrap();
        let second = project.place(&media, Some(0), 4.0).unwrap();
        project.add_track(TrackKind::Video);
        let lower = project.tracks.iter().rposition(|t| t.kind == TrackKind::Video).unwrap();
        app.open(project);
        let mut host = TestHost(Vec::new());
        frame(&mut app, &ctx, &mut host, Vec::new());

        // C picks the clip under the playhead; ] the one after, bringing the playhead to it.
        app.playhead = 1.0;
        frame(&mut app, &ctx, &mut host, key(Key::C, Modifiers::NONE));
        assert_eq!(app.timeline.selection, [first.clone()]);
        frame(&mut app, &ctx, &mut host, key(Key::CloseBracket, Modifiers::NONE));
        assert_eq!(app.timeline.selection, [second.clone()]);
        assert!((app.playhead - 4.0).abs() < 1e-9);

        // Alt+→ moves it a frame later; Alt+↓ moves it to the track below.
        frame(&mut app, &ctx, &mut host, key(Key::ArrowRight, Modifiers::ALT));
        assert!((start(&app, &second) - (4.0 + 1.0 / 30.0)).abs() < 1e-6);
        frame(&mut app, &ctx, &mut host, key(Key::ArrowDown, Modifiers::ALT));
        assert_eq!(app.project.find(&second).unwrap().track, lower);

        // F fades it in and out; Ctrl+Z undoes that, and only that.
        frame(&mut app, &ctx, &mut host, key(Key::F, Modifiers::NONE));
        assert!(app.project.clip(&second).unwrap().fade_in > 0.0);
        frame(&mut app, &ctx, &mut host, key(Key::Z, Modifiers::COMMAND));
        assert_eq!(app.project.clip(&second).unwrap().fade_in, 0.0);
        assert_eq!(app.project.find(&second).unwrap().track, lower);

        // Enter opens the Clip menu with the keyboard on its first field; Escape leaves it.
        frame(&mut app, &ctx, &mut host, key(Key::Enter, Modifiers::NONE));
        frame(&mut app, &ctx, &mut host, Vec::new());
        frame(&mut app, &ctx, &mut host, Vec::new());
        assert!(egui::Popup::is_any_open(&ctx), "the Clip menu is open");
        assert!(ctx.memory(|m| m.focused().is_some()), "a field in it has the keyboard");
        // While it does, plain keys type into it instead of editing: S doesn't split.
        let clips = app.project.tracks.iter().map(|t| t.clips.len()).sum::<usize>();
        frame(&mut app, &ctx, &mut host, key(Key::S, Modifiers::NONE));
        assert_eq!(app.project.tracks.iter().map(|t| t.clips.len()).sum::<usize>(), clips);
        frame(&mut app, &ctx, &mut host, key(Key::Escape, Modifiers::NONE));
        frame(&mut app, &ctx, &mut host, Vec::new());
        assert!(!ctx.memory(|m| m.focused().is_some()));
        assert!(!egui::Popup::is_any_open(&ctx), "Escape closes the menu");
        assert_eq!(app.timeline.selection, [second.clone()], "and keeps the clip picked");

        // F1 opens Commands; typing finds one, Enter runs it.
        let snap = app.timeline.snap;
        frame(&mut app, &ctx, &mut host, key(Key::F1, Modifiers::NONE));
        assert!(app.palette.is_some());
        frame(&mut app, &ctx, &mut host, Vec::new());
        frame(&mut app, &ctx, &mut host, vec![egui::Event::Text("snapping".into())]);
        frame(&mut app, &ctx, &mut host, key(Key::Enter, Modifiers::NONE));
        assert!(app.palette.is_none());
        assert_eq!(app.timeline.snap, !snap);

        // Ctrl+S: the Change clip speed window, the keyboard on Speed; typing 50 and Enter makes it half speed,
        // twice as long, with what comes after moved along.
        app.timeline.selection = vec![first.clone()];
        let after_first = app.project.tracks.iter().flat_map(|t| &t.clips).filter(|c| c.id != first && c.start >= 4.0 - 1e-9).map(|c| (c.id.clone(), c.start)).collect::<Vec<_>>();
        frame(&mut app, &ctx, &mut host, key(Key::S, Modifiers::COMMAND));
        assert!(app.speed_dialog.is_some());
        frame(&mut app, &ctx, &mut host, Vec::new());
        frame(&mut app, &ctx, &mut host, Vec::new());
        assert!(ctx.memory(|m| m.focused().is_some()), "Speed has the keyboard");
        frame(&mut app, &ctx, &mut host, key(Key::A, Modifiers::COMMAND));
        frame(&mut app, &ctx, &mut host, vec![egui::Event::Text("50".into())]);
        frame(&mut app, &ctx, &mut host, key(Key::Enter, Modifiers::NONE));
        frame(&mut app, &ctx, &mut host, Vec::new());
        assert!(app.speed_dialog.is_none(), "Enter changed it and closed the window");
        let clip = app.project.clip(&first).unwrap();
        assert_eq!((clip.speed, clip.duration), (0.5, 8.0));
        for (id, was) in after_first {
            assert_eq!(app.project.clip(&id).unwrap().start, was + 4.0, "moved along");
        }
        frame(&mut app, &ctx, &mut host, key(Key::Z, Modifiers::COMMAND));
        assert_eq!(app.project.clip(&first).unwrap().speed, 1.0, "one undo step");

        // Delete removes the picked clip.
        app.timeline.selection = vec![first.clone()];
        frame(&mut app, &ctx, &mut host, key(Key::Delete, Modifiers::NONE));
        assert!(app.project.clip(&first).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Right-click > Edit the picture in Folio asks Canopy to open it in Folio; what Folio's Save sends back
    /// replaces the picture in the project it came from, even with another project open by then.
    #[test]
    fn a_picture_edited_in_folio_replaces_the_old_one() {
        #[derive(Default)]
        struct Canopy(Vec<String>, Vec<(String, String)>);
        impl Host for Canopy {
            fn toast(&mut self, text: String) {
                self.0.push(text);
            }
            fn exported(&mut self, _: PathBuf) {}
            fn open_in(&mut self, app: &str, document: &str) -> bool {
                self.1.push((app.into(), document.into()));
                true
            }
        }
        let dir = std::env::temp_dir().join(format!("streamcuts-folio-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let picture = dir.join("logo.png");
        image::RgbaImage::from_pixel(64, 32, image::Rgba([255, 0, 0, 255])).save(&picture).unwrap();
        let place = Place { space: None, projects_dir: dir.join("projects"), data_dir: dir.join("data"), exports_dir: dir.join("exports") };
        let ctx = egui::Context::default();
        let mut app = StreamCuts::new(place, &ctx);
        let mut project = Project::new("With a logo");
        let media = project.add_media(Media {
            id: "logo".into(),
            path: picture.clone(),
            name: "logo.png".into(),
            kind: MediaKind::Image,
            duration: 0.0,
            width: 64,
            height: 32,
            has_audio: false,
            frame_rate: 0.0,
            attributes: Attributes::default(),
        });
        let clip = project.place(&media, Some(0), 2.0).unwrap();
        let id = project.id.clone();
        app.open(project);
        assert!(folio_can_edit(app.project.media("logo").unwrap()));

        let mut canopy = Canopy::default();
        app.edit_in_folio(&clip, &mut canopy);
        let (to, document) = canopy.1.last().unwrap().clone();
        assert_eq!(to, "folio");
        let request: serde_json::Value = serde_json::from_str(document.strip_prefix(EDIT_PICTURE).unwrap()).unwrap();
        assert_eq!(request["path"], picture.to_string_lossy().as_ref());
        assert_eq!(request["app"], "streamcuts");
        assert!(storage::find(&app.place.projects_dir, &id).is_some(), "saved, so it can be found again");

        // Meanwhile another project is opened; Folio's Save sends a bigger edited copy back.
        app.open(Project::new("Something else"));
        let edited = dir.join("logo (edited).png");
        image::RgbaImage::from_pixel(128, 64, image::Rgba([0, 0, 255, 128])).save(&edited).unwrap();
        let back = serde_json::json!({ "path": edited.to_string_lossy(), "reply": request["reply"] });
        app.open_document(&format!("{EDITED_PICTURE}{back}"), &mut canopy);
        assert_eq!(canopy.0.last().unwrap(), "Replaced logo.png with Folio's edit");
        assert_eq!(app.project.id, id, "the picture's own project is back");
        let replaced = app.project.media("logo").unwrap();
        assert_eq!((replaced.path.clone(), replaced.width, replaced.height), (edited.clone(), 128, 64));
        assert!(app.project.clip(&clip).is_some(), "the clip stays where it was");
        assert!(picture.is_file(), "the original file is left alone");
        // It's an edit like any other: undo puts the old picture back.
        app.history.undo(&mut app.project);
        assert_eq!(app.project.media("logo").unwrap().path, picture);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
