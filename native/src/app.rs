//! The StreamCuts editor: toolbar, media bin, preview with transport, and the timeline. One instance runs per space in
//! Canopy, or alone in StreamCuts' own window.

use crate::audio::Audio;
use crate::boss::Suggestion;
use crate::captions;
use crate::export::{self, Export};
use crate::ffmpeg::Frame;
use crate::preview::{Clock, Preview};
use crate::project::{Effects, ExportFormat, Framing, Grade, History, MediaKind, Picture, Project, SPEEDS, Sound};
use crate::storage;
use crate::filmstrip::Strip;
use crate::timeline::{Looks, MediaDrag, Timeline, timecode};
use crate::worker::{Done, Job, Worker};
use canopy_ui::canopy_core::files::Kind;
use canopy_ui::{CanopyApp, Host, Icon, Mood, Place, Receipt, SharedFile, color, font, icon, icon_button, pane_frame, pill, primary_button, quiet_button};
use egui::{Align2, Color32, ColorImage, Key, Modifiers, Rect, Sense, TextureHandle, TextureOptions, Ui, UiBuilder, pos2, vec2};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

const BIN_WIDTH: f32 = 250.0;
/// Below this width (half of a split Canopy window) the toolbar folds its text buttons into icons.
const NARROW: f32 = 780.0;
const SHAPES: [(&str, u32, u32); 3] = [("16:9", 1920, 1080), ("9:16", 1080, 1920), ("1:1", 1080, 1080)];

/// Where a file being imported goes once it has been probed.
struct Pending {
    at: f64,
    track: Option<usize>,
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
    boss_running: Option<String>,
    /// Media whose scenes are being found.
    scene_jobs: Vec<String>,
    /// Media whose editing proxy is being made.
    proxy_jobs: Vec<String>,
    boss_plan: Option<BossPlan>,
    /// Typing in a caption: one undo step for the whole edit.
    caption_typing: bool,
    /// The Media search, and whether a file's notes are being typed (one undo step per note).
    media_search: String,
    media_typing: bool,
    /// Dragging a clip setting: one undo step for the whole drag.
    adjusting: bool,
    /// Media whose waveform and filmstrip have been asked for.
    looks_asked: HashSet<String>,
    pending: HashMap<PathBuf, Pending>,
    preview: Preview,
    clock: Clock,
    audio: Audio,
    playhead: f64,
    timeline: Timeline,
    export: Option<Export>,
    show_projects: bool,
    toasts: Vec<String>,
    exported: Vec<PathBuf>,
}

impl StreamCuts {
    pub fn new(place: Place, ctx: &egui::Context) -> Self {
        let _ = std::fs::create_dir_all(&place.projects_dir);
        // Open the most recent project here, or start one.
        let project = storage::list(&place.projects_dir)
            .first()
            .and_then(|doc| storage::load(&place.projects_dir.join(&doc.id)).ok())
            .unwrap_or_else(|| Project::new("Untitled cut"));
        let mut app = Self {
            place,
            project,
            history: History::default(),
            edited_at: None,
            worker: Worker::new(ctx.clone()),
            looks: Looks::default(),
            transcribing: 0,
            boss_running: None,
            scene_jobs: Vec::new(),
            proxy_jobs: Vec::new(),
            boss_plan: None,
            caption_typing: false,
            media_search: String::new(),
            media_typing: false,
            adjusting: false,
            looks_asked: HashSet::new(),
            pending: HashMap::new(),
            preview: Preview::default(),
            clock: Clock::default(),
            audio: Audio::default(),
            playhead: 0.0,
            timeline: Timeline::default(),
            export: None,
            show_projects: false,
            toasts: Vec::new(),
            exported: Vec::new(),
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
                    self.worker.send(Job::Waveform { media_id: media.id.clone(), path: media.path.clone(), cache: self.place.data_dir.clone() });
                }
                if media.kind == MediaKind::Video {
                    self.worker.send(Job::Filmstrip { media_id: media.id.clone(), path: media.path.clone(), duration: media.duration, cache: self.place.data_dir.clone() });
                }
            }
            if !self.looks.thumbnails.contains_key(&media.id) && media.kind != MediaKind::Audio {
                self.worker.send(Job::Thumbnail { media_id: media.id.clone(), path: media.path.clone(), at: (media.duration * 0.1).min(1.0) });
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
        self.preview.reset();
        self.request_looks();
    }

    fn import(&mut self, files: Vec<PathBuf>, at: f64, track: Option<usize>) {
        for path in files {
            self.pending.insert(path.clone(), Pending { at, track });
            self.worker.send(Job::Probe(path));
        }
    }

    fn texture(ctx: &egui::Context, name: &str, frame: &Frame) -> TextureHandle {
        ctx.load_texture(name, ColorImage::from_rgba_unmultiplied(frame.size, &frame.rgba), TextureOptions::LINEAR)
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
                            if let Some(p) = pending {
                                if let Some(clip) = self.project.place(&id, p.track, p.at) {
                                    self.timeline.selection = vec![clip];
                                }
                            }
                            self.request_looks();
                            self.edited();
                        }
                        Err(error) => self.toasts.push(error),
                    }
                }
                Done::Thumbnail(id, Ok(frame)) => {
                    let texture = Self::texture(ctx, &format!("thumb-{id}"), &frame);
                    self.looks.thumbnails.insert(id, texture);
                }
                Done::Thumbnail(_, Err(_)) => {}
                Done::Still(key, frame) => self.preview.still_done(ctx, key, frame),
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
                            self.toasts.push(if count == 0 { "No speech found for captions".into() } else { format!("Added {count} caption{}", if count == 1 { "" } else { "s" }) });
                        }
                        Err(error) => self.toasts.push(error),
                    }
                }
                Done::Loudness { clip, normalize, result } => match result {
                    Ok(lufs) => {
                        let volume = self.project.clip(&clip).map_or(1.0, |c| c.volume as f64);
                        // The measure is of the source; the clip plays it at its volume.
                        let heard = lufs + 20.0 * volume.max(1e-6).log10();
                        if normalize {
                            // To -14 LUFS, within what the volume slider allows (0-200 %).
                            let target = (volume * 10f64.powf((-14.0 - heard) / 20.0)).clamp(0.0, 2.0);
                            self.history.record(&self.project);
                            if let Some(c) = self.project.clip_mut(&clip) {
                                c.volume = target as f32;
                            }
                            self.edited();
                            self.toasts.push(format!("Was {heard:.1} LUFS; volume set to {:.0} %", target * 100.0));
                        } else {
                            self.toasts.push(format!("This clip plays at {heard:.1} LUFS (social apps play at -14)"));
                        }
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
                Done::Boss { media_id, result } => {
                    self.boss_running = None;
                    match result {
                        Ok(suggestions) if !suggestions.is_empty() => self.boss_plan = Some(BossPlan { media_id, suggestions }),
                        Ok(_) => self.toasts.push("Boss AI found no shorts in this video".into()),
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
            selected.iter().filter_map(|id| self.project.split(id, self.playhead)).count()
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

    fn shortcuts(&mut self, ui: &Ui, focused: bool) {
        if !focused || ui.ctx().egui_wants_keyboard_input() {
            return;
        }
        let ctx = ui.ctx();
        if ctx.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Space)) {
            self.toggle_play();
        }
        if ctx.input_mut(|i| i.consume_key(Modifiers::NONE, Key::S)) {
            self.split();
        }
        if ctx.input_mut(|i| i.consume_key(Modifiers::SHIFT, Key::Delete) || i.consume_key(Modifiers::SHIFT, Key::Backspace)) {
            self.delete_selection(true);
        }
        if ctx.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Delete) || i.consume_key(Modifiers::NONE, Key::Backspace)) {
            self.delete_selection(false);
        }
        if ctx.input_mut(|i| i.consume_key(Modifiers::COMMAND | Modifiers::SHIFT, Key::Z) || i.consume_key(Modifiers::COMMAND, Key::Y)) {
            if self.history.redo(&mut self.project) {
                self.edited();
            }
        } else if ctx.input_mut(|i| i.consume_key(Modifiers::COMMAND, Key::Z)) && self.history.undo(&mut self.project) {
            self.edited();
        }
        let frame = 1.0 / self.project.fps as f64;
        // Before the plain arrows, which would also take Shift+arrow.
        for (key, back) in [(Key::ArrowLeft, true), (Key::ArrowRight, false)] {
            if ctx.input_mut(|i| i.consume_key(Modifiers::SHIFT, key)) {
                if let Some(t) = self.project.next_marker(self.playhead, back) {
                    self.seek(t);
                }
            }
        }
        if ctx.input_mut(|i| i.consume_key(Modifiers::NONE, Key::ArrowLeft)) {
            self.seek(self.playhead - frame);
        }
        if ctx.input_mut(|i| i.consume_key(Modifiers::NONE, Key::ArrowRight)) {
            self.seek(self.playhead + frame);
        }
        if ctx.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Home)) {
            self.seek(0.0);
        }
        // Markers: M marks the playhead; Shift+Left / Shift+Right go to the one before or after.
        if ctx.input_mut(|i| i.consume_key(Modifiers::NONE, Key::M)) {
            self.history.record(&self.project);
            if self.project.add_marker(self.playhead, "") {
                self.edited();
            }
        }
        if ctx.input_mut(|i| i.consume_key(Modifiers::NONE, Key::End)) {
            self.seek(self.project.duration());
        }
    }

    fn toolbar(&mut self, ui: &mut Ui) {
        let narrow = ui.available_width() < NARROW;
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 6.0;
            let name = ui.add(egui::TextEdit::singleline(&mut self.project.name).font(font::bold(15.0)).desired_width(if narrow { 130.0 } else { 220.0 }).margin(vec2(8.0, 6.0)));
            if name.changed() {
                self.edited();
            }
            if icon_button(ui, Icon::Undo, "Undo (Ctrl+Z)", false).clicked() && self.history.undo(&mut self.project) {
                self.edited();
            }
            if icon_button(ui, Icon::Redo, "Redo (Ctrl+Shift+Z)", false).clicked() && self.history.redo(&mut self.project) {
                self.edited();
            }
            let import = if narrow { icon_button(ui, Icon::Plus, "Import", false) } else { quiet_button(ui, "Import", Some(Icon::Plus)) };
            if import.clicked() {
                if let Some(files) = rfd::FileDialog::new().set_title("Import media").add_filter("Video, pictures and sound", &["mp4", "mov", "mkv", "webm", "avi", "m4v", "png", "jpg", "jpeg", "webp", "gif", "mp3", "wav", "m4a", "aac", "flac", "ogg"]).pick_files() {
                    let at = self.project.duration();
                    self.import(files, at, None);
                }
            }
            let boss = if narrow { icon_button(ui, Icon::Scissors, "Boss AI: find shorts in a video", self.boss_running.is_some()) } else { quiet_button(ui, "Boss AI", Some(Icon::Scissors)) };
            if boss.clicked() && self.boss_running.is_none() {
                self.start_boss();
            }
            let current = SHAPES.iter().position(|&(_, w, h)| (self.project.width, self.project.height) == (w, h));
            let mut shape = None;
            if narrow {
                // One pill that steps through the shapes.
                let label = current.map_or("Shape", |i| SHAPES[i].0);
                if pill(ui, label, None, false).on_hover_text("Change the shape: 16:9, 9:16 or 1:1").clicked() {
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
                self.history.record(&self.project);
                (_, self.project.width, self.project.height) = SHAPES[i];
                self.preview.reset();
                self.edited();
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if primary_button(ui, "Export", Mood::Ember).clicked() && self.export.is_none() {
                    self.start_export(ui.ctx());
                }
                let projects = if narrow { icon_button(ui, Icon::Project, "Projects", self.show_projects) } else { quiet_button(ui, "Projects", Some(Icon::Project)) };
                if projects.clicked() {
                    self.show_projects = !self.show_projects;
                }
                let even = self.project.even_loudness;
                let hint = "Even out the loudness when exporting, to the -14 LUFS social apps play at";
                let toggle = if narrow { icon_button(ui, Icon::Audio, hint, even) } else { pill(ui, "Even loudness", None, even).on_hover_text(hint) };
                if toggle.clicked() {
                    self.history.record(&self.project);
                    self.project.even_loudness = !even;
                    self.edited();
                }
                let mut format = self.project.export_format;
                egui::ComboBox::from_id_salt("streamcuts-export-format").selected_text(format.label()).width(120.0).show_ui(ui, |ui| {
                    for choice in ExportFormat::ALL {
                        ui.selectable_value(&mut format, choice, choice.label());
                    }
                }).response.on_hover_text("What Export makes");
                if format != self.project.export_format {
                    self.history.record(&self.project);
                    self.project.export_format = format;
                    self.edited();
                }
            });
        });
    }

    fn start_boss(&mut self) {
        if std::env::var_os("GEMINI_API_KEY").is_none() && std::env::var_os("STREAMCUTS_BOSS_RESPONSE").is_none() {
            self.toasts.push("Set GEMINI_API_KEY to use Boss AI".into());
            return;
        }
        let selected = self.timeline.selection.iter().find_map(|id| self.project.clip(id)).map(|clip| clip.media_id.as_str());
        let media = selected.and_then(|id| self.project.media(id)).filter(|m| m.kind == MediaKind::Video)
            .or_else(|| self.project.media.iter().find(|m| m.kind == MediaKind::Video));
        let Some(media) = media else { self.toasts.push("Import a video to find shorts".into()); return };
        if !media.path.is_file() { self.toasts.push(format!("{} is missing", media.name)); return; }
        self.boss_running = Some(media.id.clone());
        self.worker.send(Job::Boss { media_id: media.id.clone(), path: media.path.clone(), duration: media.duration });
        self.toasts.push("Boss AI is transcribing and finding shorts; long videos can take a while".into());
    }

    fn boss_window(&mut self, ui: &mut Ui) {
        let Some(plan) = &self.boss_plan else { return };
        let mut selected = None;
        let modal = egui::Modal::new(ui.scope_id().with("boss-plan")).show(ui.ctx(), |ui| {
            ui.set_width(440.0);
            ui.label(egui::RichText::new("Shorts Boss found").font(font::display(20.0)));
            ui.label("Pick a moment to open it as a 9:16 project with a title and captions.");
            ui.add_space(8.0);
            egui::ScrollArea::vertical().max_height(360.0).show(ui, |ui| {
                for (index, short) in plan.suggestions.iter().enumerate() {
                    let label = format!("{}  ·  {}–{}", short.title, timecode(short.start_seconds, self.project.fps), timecode(short.end_seconds, self.project.fps));
                    if quiet_button(ui, &label, Some(Icon::Scissors)).clicked() { selected = Some(index); }
                    if !short.description.is_empty() { ui.label(&short.description); }
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
        let Some(media) = self.project.media(media_id).cloned() else { return };
        let mut project = Project::new(&short.title);
        project.width = 1080;
        project.height = 1920;
        let id = project.add_media(media.clone());
        let Some(clip_id) = project.place(&id, None, 0.0) else { return };
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
            self.worker.send(Job::Transcribe { clip: clip_id, path: media.path, from: short.start_seconds, length: short.end_seconds - short.start_seconds, speed: 1.0, at: 0.0 });
            self.transcribing += 1;
        }
    }

    /// Asks where a missing file went and points the project there. The clips keep their place and trims.
    fn find_media(&mut self, id: &str) {
        let Some(media) = self.project.media(id).cloned() else { return };
        let mut dialog = rfd::FileDialog::new().set_title(format!("Where is {}?", media.name));
        if let Some(folder) = media.path.parent().filter(|f| f.is_dir()) {
            dialog = dialog.set_directory(folder);
        }
        let Some(path) = dialog.pick_file() else { return };
        self.history.record(&self.project);
        if let Some(target) = self.project.media.iter_mut().find(|m| m.id == id) {
            target.name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(target.name.clone());
            target.path = path;
        }
        self.looks.thumbnails.remove(id);
        self.looks_asked.remove(id);
        self.preview.reset();
        self.request_looks();
        self.edited();
    }

    fn start_export(&mut self, ctx: &egui::Context) {
        if let Some(media) = self.project.missing_media().first() {
            self.toasts.push(format!("Can't export: {} is missing. Click it in Media to find it.", media.name));
            return;
        }
        let _ = std::fs::create_dir_all(&self.place.exports_dir);
        let name = canopy_ui::canopy_core::files::unique_name(&self.place.exports_dir, &format!("{}.{}", self.project.name, self.project.export_format.extension()));
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
        ui.label(egui::RichText::new("Media").font(font::ui(12.0)).color(color::INK_MUTED));
        if self.project.media.is_empty() {
            ui.add_space(12.0);
            ui.label(egui::RichText::new("Import video, pictures or sound, or drop files here.").color(color::INK_MUTED));
            return;
        }
        // A search (words, #tag, 3* for three stars or more), and saved searches to pick from: the smart bins.
        let searching = !self.media_search.trim().is_empty();
        ui.horizontal(|ui| {
            let width = ui.available_width() - if searching { 76.0 } else { 0.0 };
            ui.add(egui::TextEdit::singleline(&mut self.media_search).hint_text("Search: words, #tag, 3*").desired_width(width))
                .on_hover_text("Words match names, notes and tags; #tag needs that tag; 3* needs three stars or more");
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
                    if ui.selectable_label(on, &bin.name).on_hover_text("A smart bin: click to show what it finds").clicked() {
                        self.media_search = if on { String::new() } else { bin.query.clone() };
                    }
                    if ui.small_button("×").on_hover_text("Delete this smart bin").clicked() {
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
        let mut place_now = None;
        let mut find = None;
        let mut remove = None;
        let mut scenes = None;
        // Changes to a file's rating, tags or notes: (media id, its new attributes, whether to keep an undo step).
        let mut noted: Option<(String, crate::project::Attributes, bool)> = None;
        let query = self.media_search.clone();
        let shown: Vec<&crate::project::Media> = self.project.media.iter().filter(|m| m.matches(&query)).collect();
        if shown.is_empty() {
            ui.label(egui::RichText::new("Nothing matches this search.").color(color::INK_MUTED));
        }
        egui::ScrollArea::vertical().auto_shrink(false).show(ui, |ui| {
            for media in shown {
                let missing = !media.path.is_file();
                let used = self.project.tracks.iter().any(|t| t.clips.iter().any(|c| c.media_id == media.id));
                // The row takes clicks and drags itself (see `canopy_ui::drag_source`).
                let (rect, row) = ui.allocate_exact_size(vec2(ui.available_width(), 46.0), Sense::click_and_drag());
                let painter = ui.painter();
                painter.rect_filled(rect, 8, color::VEIL);
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
                    let mut detail = match media.kind { MediaKind::Image => format!("Picture · {}×{}", media.width, media.height), _ => timecode(media.duration, self.project.fps) };
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
                    if ui.add_enabled(!used, egui::Button::new("Remove from project")).on_disabled_hover_text("A clip on the timeline uses it").clicked() {
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
            self.toasts.push("Finding scene changes; long videos take a while".into());
        }
        if let Some(id) = remove {
            self.history.record(&self.project);
            if self.project.remove_media(&id) {
                self.edited();
            }
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
        let size = if area.width() / area.height() > aspect { vec2(area.height() * aspect, area.height()) } else { vec2(area.width(), area.width() / aspect) };
        let screen = Rect::from_center_size(area.center(), size);
        ui.painter().rect_filled(screen, 4, Color32::BLACK);
        if let (Some(texture), false) = (&self.preview.texture, self.preview.blank) {
            // A clip fading in or out shows darker (exports fade it to what's below, which is black unless tracks stack).
            let fade = if self.project.crossfade_at(self.playhead).is_some() { 1.0 }
                else { self.project.front_clip(self.playhead).map_or(1.0, |(clip, _)| {
                    if self.project.crossfade_before(&clip.id).is_some() {
                        if clip.fade_out > 0.0 { ((clip.end() - self.playhead) / clip.fade_out).clamp(0.0, 1.0) } else { 1.0 }
                    } else { clip.fade_at(self.playhead) }
                }) };
            let tint = Color32::from_gray((fade * 255.0).round() as u8);
            ui.painter().image(texture.id(), screen, Rect::from_min_max(pos2(0.0, 0.0), pos2(1.0, 1.0)), tint);
            // Scrubbing: until the exact still arrives (a static FFmpeg takes half a second to start), show the nearest
            // filmstrip frame, which is there at once. Only when it looks the same: a 16:9 frame, fitted, ungraded.
            if self.preview.waiting() && self.project.width * 9 == self.project.height * 16 {
                if let Some((clip, media)) = self.project.front_clip(self.playhead).filter(|(clip, _)| clip.picture() == Picture::default()) {
                    if let Some(strip) = self.looks.filmstrips.get(&media.id) {
                        ui.painter().image(strip.texture.id(), screen, strip.uv(clip.source_time(self.playhead)), tint);
                    }
                }
            }
        }
        let over_picture = ui.painter().with_clip_rect(screen);
        for title in self.project.titles.iter().filter(|t| self.playhead >= t.start && self.playhead < t.end) {
            captions::draw_title(&over_picture, screen, title);
        }
        if let Some(caption) = self.project.caption_at(self.playhead) {
            let word = self.project.caption_words.then(|| caption.word_at(self.playhead)).flatten();
            captions::draw(&over_picture, screen, &caption.text, word, self.project.caption_bottom);
        }
        if self.preview.scopes.on {
            self.preview.scopes.draw(ui.painter(), Rect::from_min_size(pos2(area.right() - 268.0, area.top() + 8.0), vec2(256.0, 210.0)));
        }
        self.drag_text(ui, screen);
        if self.project.duration() == 0.0 {
            ui.painter().text(screen.center(), Align2::CENTER_CENTER, "Drag media onto the timeline to start", font::ui(14.0), color::INK_MUTED);
        } else if let Some((_, media)) = self.project.front_clip(self.playhead).filter(|(_, media)| !media.path.is_file()) {
            ui.painter().text(screen.center(), Align2::CENTER_CENTER, format!("{} is missing: find it in Media", media.name), font::ui(14.0), color::INK_MUTED);
        }
        let bar = Rect::from_min_max(pos2(full.left(), full.bottom() - transport + 6.0), full.max);
        ui.scope_builder(UiBuilder::new().max_rect(bar), |ui| {
            ui.horizontal_centered(|ui| {
                ui.add_space((bar.width() / 2.0 - 70.0).max(0.0));
                if icon_button(ui, Icon::SkipBack, "Go to start (Home)", false).clicked() {
                    self.seek(0.0);
                }
                let playing = self.clock.playing;
                if icon_button(ui, if playing { Icon::Pause } else { Icon::Play }, if playing { "Pause (Space)" } else { "Play (Space)" }, false).clicked() {
                    self.toggle_play();
                }
                if icon_button(ui, Icon::SkipForward, "Go to end (End)", false).clicked() {
                    self.seek(self.project.duration());
                }
                ui.label(egui::RichText::new(format!("{} / {}", timecode(self.playhead, self.project.fps), timecode(self.project.duration(), self.project.fps))).font(font::ui(13.0)).color(color::INK_SOFT));
                ui.add_space(12.0);
                let on = self.preview.scopes.on;
                if ui.selectable_label(on, "Scopes").on_hover_text("Histogram and luma waveform of the picture").clicked() {
                    self.preview.scopes.on = !on;
                    // Measured from the next picture shown: ask for the one here again.
                    if !on {
                        self.preview.reset();
                    }
                }
            });
        });
    }

    /// Dragging up or down on the picture moves the selected title, or with a caption selected, where captions sit.
    fn drag_text(&mut self, ui: &mut Ui, screen: Rect) {
        let [id] = self.timeline.selection.as_slice() else { return };
        let title = self.project.titles.iter().any(|t| &t.id == id);
        if !title && !self.project.captions.iter().any(|c| &c.id == id) {
            return;
        }
        let id = id.clone();
        let response = ui.interact(screen, ui.scope_id().with("drag-text"), Sense::drag())
            .on_hover_cursor(egui::CursorIcon::ResizeVertical)
            .on_hover_text(if title { "Drag up or down to move the title" } else { "Drag up or down to move the captions" });
        if response.drag_started() {
            self.history.record(&self.project);
        }
        let dy = response.drag_delta().y / screen.height();
        if response.dragged() && dy != 0.0 {
            if title {
                if let Some(title) = self.project.title_mut(&id) {
                    title.y = (title.y + dy).clamp(0.05, 0.95);
                }
            } else {
                self.project.caption_bottom = (self.project.caption_bottom - dy).clamp(0.02, 0.8);
            }
            self.edited();
        }
    }

    fn timeline_bar(&mut self, ui: &mut Ui) {
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 4.0;
            if icon_button(ui, Icon::Scissors, "Split at the playhead (S)", false).clicked() {
                self.split();
            }
            if icon_button(ui, Icon::Trash, "Delete (Delete; Shift+Delete closes the gap)", false).clicked() {
                let ripple = ui.input(|i| i.modifiers.shift);
                self.delete_selection(ripple);
            }
            if icon_button(ui, Icon::Magnet, "Snap to clips and the playhead", self.timeline.snap).clicked() {
                self.timeline.snap = !self.timeline.snap;
            }
            if icon_button(ui, Icon::Plus, "Add a video track", false).clicked() {
                self.history.record(&self.project);
                self.project.add_track(crate::project::TrackKind::Video);
                self.edited();
            }
            let label = if self.transcribing > 0 { "Making captions…" } else { "Make captions from speech (the selected clips, or every clip with sound)" };
            if icon_button(ui, Icon::Captions, label, self.transcribing > 0).clicked() && self.transcribing == 0 {
                self.make_captions();
            }
            if self.transcribing > 0 {
                ui.label(egui::RichText::new("Making captions…").font(font::ui(12.0)).color(color::INK_MUTED));
            }
            if icon_button(ui, Icon::Text, "Add a title at the playhead", false).clicked() {
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
                if icon_button(ui, Icon::ZoomIn, "Zoom in (Ctrl+wheel)", false).clicked() {
                    self.timeline.pps = (self.timeline.pps * 1.5).min(600.0);
                }
                if icon_button(ui, Icon::ZoomOut, "Zoom out (Ctrl+wheel)", false).clicked() {
                    self.timeline.pps = (self.timeline.pps / 1.5).max(2.0);
                }
            });
        });
    }

    /// Transcribes the selected clips with sound, or every clip with sound when none is selected.
    fn make_captions(&mut self) {
        let selected: Vec<_> = self.project.audible_clips().into_iter().filter(|(clip, _)| self.timeline.selection.contains(&clip.id)).collect();
        let clips = if selected.is_empty() { self.project.audible_clips() } else { selected };
        if clips.is_empty() {
            self.toasts.push("Add a clip with sound to make captions".into());
            return;
        }
        for (clip, media) in clips {
            self.worker.send(Job::Transcribe { clip: clip.id.clone(), path: media.path.clone(), from: clip.source_in, length: clip.source_length(), speed: clip.speed, at: clip.start });
            self.transcribing += 1;
        }
        self.toasts.push("Making captions; the first time takes a minute while the speech model loads".into());
    }

    /// One selected clip gets a menu for its fades, speed and, for pictures, how it sits in the frame and its color.
    fn clip_settings(&mut self, ui: &mut Ui) {
        let [id] = self.timeline.selection.as_slice() else { return };
        let Some(clip) = self.project.clip(id).cloned() else { return };
        let Some(kind) = self.project.media(&clip.media_id).map(|media| media.kind) else { return };
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
        // Some(true) detaches the clip's sound onto an audio track, Some(false) unlinks it from its linked clip.
        let mut link = None;
        let has_sound = self.project.media(&clip.media_id).is_some_and(|m| m.has_audio) && !self.project.sounds_elsewhere(&clip);
        egui::containers::menu::MenuButton::new(egui::RichText::new("Clip").font(font::ui(13.0))).config(stays_open()).ui(ui, |ui| {
            ui.set_min_width(230.0);
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
                ui.add(egui::DragValue::new(&mut changed.fade_in).range(0.0..=longest).speed(0.02).fixed_decimals(2).suffix(" s"));
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
                    ui.add(egui::Slider::new(x, 0.0..=1.0).show_value(false).text("Left to right"));
                    ui.add(egui::Slider::new(y, 0.0..=1.0).show_value(false).text("Top to bottom"));
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
        match (proxy, media_path.clone()) {
            (Some(true), Some(path)) => match self.proxy_entry(&path) {
                Some(output) => {
                    self.proxy_jobs.push(clip.media_id.clone());
                    self.worker.send(Job::Proxy { media_id: clip.media_id.clone(), path, output });
                    self.toasts.push("Making an editing proxy; long videos take a while".into());
                }
                None => self.toasts.push("Couldn't read the video to make a proxy".into()),
            },
            (Some(false), _) => {
                if let Some(file) = self.preview.proxies.remove(&clip.media_id) {
                    // Stop playing from it before deleting it.
                    self.preview.reset();
                    if std::fs::remove_file(&file).is_err() {
                        self.toasts.push(format!("Couldn't delete the proxy; it's at {}", file.display()));
                    }
                }
            }
            _ => {}
        }
        if let (Some(normalize), Some(path)) = (loudness, media_path.clone()) {
            self.worker.send(Job::Loudness { clip: clip.id.clone(), path, from: clip.source_in, length: clip.source_length(), normalize });
            self.toasts.push("Measuring loudness…".into());
        }
        if let (true, Some(path)) = (find_scenes, media_path) {
            self.scene_jobs.push(clip.media_id.clone());
            self.worker.send(Job::Scenes { media_id: clip.media_id.clone(), path });
            self.toasts.push("Finding scene changes; long videos take a while".into());
        }
        if let Some(detach) = link {
            self.history.record(&self.project);
            let done = if detach { self.project.detach_sound(&clip.id).is_some() } else { self.project.unlink(&clip.id) };
            if done {
                self.edited();
            }
        }
    }

    /// One selected title gets its text, and a menu for its size, height and length, in the timeline bar.
    fn title_editor(&mut self, ui: &mut Ui) {
        let [id] = self.timeline.selection.as_slice() else { return };
        let Some(title) = self.project.titles.iter().find(|t| &t.id == id).cloned() else { return };
        let id = id.clone();
        let mut changed = title.clone();
        ui.add_space(10.0);
        let field = ui.add(egui::TextEdit::singleline(&mut changed.text).desired_width(ui.available_width().clamp(100.0, 260.0) - 60.0).hint_text("Title"));
        egui::containers::menu::MenuButton::new(egui::RichText::new("Size & place").font(font::ui(13.0))).config(stays_open()).ui(ui, |ui| {
            ui.set_min_width(240.0);
            ui.add(egui::Slider::new(&mut changed.size, 0.03..=0.25).show_value(false).text("Size"));
            ui.horizontal(|ui| {
                for (label, y) in [("Top", 0.15), ("Middle", 0.5), ("Bottom", 0.82)] {
                    if ui.selectable_label((changed.y - y).abs() < 0.01, label).clicked() {
                        changed.y = y;
                    }
                }
            });
            ui.add(egui::Slider::new(&mut changed.y, 0.05..=0.95).show_value(false).text("Height"));
            let mut length = changed.end - changed.start;
            if ui.add(egui::DragValue::new(&mut length).range(0.5..=600.0).speed(0.05).fixed_decimals(1).prefix("Shows for ").suffix(" s")).changed() {
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
        let [id] = self.timeline.selection.as_slice() else { return };
        let Some(index) = self.project.captions.iter().position(|c| &c.id == id) else { return };
        let mut text = self.project.captions[index].text.clone();
        ui.add_space(10.0);
        let field = ui.add(egui::TextEdit::singleline(&mut text).desired_width(ui.available_width().clamp(120.0, 420.0) - 80.0).hint_text("Caption"));
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
        if ui.checkbox(&mut words, "Word by word").on_hover_text("Light up each word as it's said (captions made from speech)").changed() {
            self.history.record(&self.project);
            self.project.caption_words = words;
            self.edited();
        }
    }

    /// One selected clip with sound gets a volume slider in the timeline bar.
    fn volume_control(&mut self, ui: &mut Ui) {
        let [id] = self.timeline.selection.as_slice() else { return };
        let Some(clip) = self.project.clip(id) else { return };
        if !self.project.media(&clip.media_id).is_some_and(|media| media.has_audio) || self.project.sounds_elsewhere(clip) {
            return;
        }
        let (id, before) = (id.clone(), clip.volume);
        let mut percent = (before * 100.0).round();
        ui.add_space(10.0);
        icon(ui.painter(), Rect::from_center_size(ui.cursor().min + vec2(8.0, 15.0), vec2(14.0, 14.0)), Icon::Audio, color::INK_SOFT);
        ui.add_space(20.0);
        let slider = ui.add(egui::Slider::new(&mut percent, 0.0..=200.0).suffix("%").step_by(1.0)).on_hover_text("The clip's volume");
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
                let current = storage::file_for(&self.place.projects_dir, &self.project).file_name().map(|n| n.to_string_lossy() == doc.id).unwrap_or(false);
                let row = canopy_ui::Row { title: &doc.name, detail: &doc.detail, mark: canopy_ui::RowMark::Icon(Icon::Project), highlighted: current }.show(ui);
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

    fn export_window(&mut self, ui: &mut Ui, host: &mut dyn Host) {
        let Some(run) = &self.export else { return };
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
            ui.label(canopy_ui::muted(format!("{} · {}×{} · {} fps", self.project.name, self.project.width, self.project.height, self.project.fps)));
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
        self.drain_worker(&ctx);
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
                self.playhead = self.audio.now().unwrap_or(self.playhead).min(self.project.duration());
                self.pause();
            }
            ctx.request_repaint();
        }
        self.preview.update(&ctx, &self.project, self.playhead, self.clock.playing, &self.worker);
        if self.edited_at.is_some_and(|at| at.elapsed() > Duration::from_millis(800)) {
            if let Err(error) = self.save() {
                host.toast(format!("Couldn't save: {error}"));
            }
        } else if self.edited_at.is_some() {
            ctx.request_repaint_after(Duration::from_millis(850));
        }

        let rect = ui.max_rect();
        let toolbar = Rect::from_min_size(rect.min, vec2(rect.width(), 40.0));
        ui.scope_builder(UiBuilder::new().max_rect(toolbar.shrink2(vec2(8.0, 4.0))), |ui| self.toolbar(ui));
        let body_top = toolbar.bottom() + 4.0;
        let timeline_height = ((rect.height() - 44.0) * 0.42).max(160.0);
        let upper = Rect::from_min_max(pos2(rect.left(), body_top), pos2(rect.right(), rect.bottom() - timeline_height - 6.0));
        let bin = Rect::from_min_size(upper.min, vec2((rect.width() * 0.2).clamp(150.0, BIN_WIDTH), upper.height()));
        let preview = Rect::from_min_max(pos2(bin.right() + 6.0, upper.top()), upper.max);
        ui.painter().add(pane_frame(Mood::Ember).paint(bin));
        ui.scope_builder(UiBuilder::new().max_rect(bin.shrink(8.0)), |ui| self.media_bin(ui));
        ui.scope_builder(UiBuilder::new().max_rect(preview), |ui| self.preview(ui));

        let lower = Rect::from_min_max(pos2(rect.left(), rect.bottom() - timeline_height), rect.max);
        ui.painter().rect_filled(lower, 10, Mood::Ember.pane());
        ui.painter().rect_stroke(lower, 10, egui::Stroke::new(1.0, color::HAIRLINE), egui::StrokeKind::Inside);
        let bar = Rect::from_min_size(lower.min + vec2(8.0, 4.0), vec2(lower.width() - 16.0, 32.0));
        ui.scope_builder(UiBuilder::new().max_rect(bar), |ui| self.timeline_bar(ui));
        let lanes = Rect::from_min_max(pos2(lower.left() + 4.0, bar.bottom() + 4.0), lower.max - vec2(4.0, 4.0));
        let output = ui.scope_builder(UiBuilder::new().max_rect(lanes), |ui| self.timeline.ui(ui, &mut self.project, &mut self.history, self.playhead, &self.looks)).inner;
        if self.clock.playing {
            self.timeline.follow(self.playhead, lanes.width());
        }
        if output.changed {
            self.edited();
        }
        if let Some(t) = output.seek {
            self.seek(t);
        }
        if let Some((files, at, track)) = output.dropped {
            self.import(files.into_iter().filter(|f| accepts(f)).map(|f| f.path).collect(), at, track);
        }
        self.projects_window(ui);
        self.boss_window(ui);
        self.export_window(ui, host);
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
        self.import(media, self.playhead, None);
        receipt
    }

    fn open_document(&mut self, id: &str, host: &mut dyn Host) {
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

/// Video, pictures and sound.
pub fn accepts(file: &SharedFile) -> bool {
    matches!(file.kind, Kind::Video | Kind::Image | Kind::Audio) || file.name.to_lowercase().ends_with(storage::EXTENSION)
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
        ui.label(egui::RichText::new(label).font(font::ui(11.0)).color(color::INK_MUTED));
        let (rect, response) = ui.allocate_exact_size(vec2(64.0, 64.0), Sense::click_and_drag());
        let (center, radius) = (rect.center(), rect.width() / 2.0);
        // Gray in the middle, and at the rim the color a push that way gives.
        let mut disc = egui::Mesh::default();
        disc.colored_vertex(center, Color32::from_gray(128));
        let steps = 48;
        for i in 0..=steps {
            let a = i as f32 / steps as f32 * std::f32::consts::TAU;
            let p = vec2(a.cos(), a.sin());
            let [r, g, b] = [0, 1, 2].map(|c| (127.5 + 127.5 * p.dot(dir(c))).clamp(0.0, 255.0) as u8);
            disc.colored_vertex(center + vec2(p.x, -p.y) * radius, Color32::from_rgb(r, g, b));
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
        let dot = (0..3).fold(egui::Vec2::ZERO, |sum, c| sum + dir(c) * [wheel.r, wheel.g, wheel.b][c]) * (2.0 / 3.0 / AMOUNT);
        ui.painter().circle(center + vec2(dot.x, -dot.y) * radius, 4.5, Color32::WHITE, egui::Stroke::new(1.5, Color32::BLACK));
        response.on_hover_text("Drag towards a color; double-click to center");
        ui.add(egui::DragValue::new(&mut wheel.master).range(-0.5..=0.5).speed(0.005).fixed_decimals(2))
            .on_hover_text(format!("{label} for all colors"));
    });
}

/// A tone curve to bend: drag one of its five points up or down (double-click puts it back on the line).
fn curve_editor(ui: &mut Ui, points: &mut [f32; 5], ink: Color32) {
    use crate::project::{CURVE_KNOTS, curve_at};
    let (rect, _) = ui.allocate_exact_size(vec2(200.0, 200.0), Sense::hover());
    let painter = ui.painter();
    painter.rect_filled(rect, 4, Color32::from_black_alpha(120));
    let at = |x: f32, y: f32| pos2(rect.left() + x * rect.width(), rect.bottom() - y * rect.height());
    for q in [0.25, 0.5, 0.75] {
        painter.line_segment([at(q, 0.0), at(q, 1.0)], egui::Stroke::new(1.0, color::HAIRLINE));
        painter.line_segment([at(0.0, q), at(1.0, q)], egui::Stroke::new(1.0, color::HAIRLINE));
    }
    painter.line_segment([at(0.0, 0.0), at(1.0, 1.0)], egui::Stroke::new(1.0, color::HAIRLINE_STRONG));
    let line: Vec<egui::Pos2> = (0..=80).map(|i| i as f32 / 80.0).map(|x| at(x, curve_at(points, x))).collect();
    painter.add(egui::Shape::line(line, egui::Stroke::new(2.0, ink)));
    for (i, x) in CURVE_KNOTS.into_iter().enumerate() {
        let handle = Rect::from_center_size(at(x, points[i]), vec2(16.0, 16.0));
        let response = ui.interact(handle, ui.scope_id().with(("curve-point", i)), Sense::click_and_drag()).on_hover_cursor(egui::CursorIcon::ResizeVertical);
        if response.double_clicked() {
            points[i] = x;
        } else if response.dragged() {
            if let Some(pointer) = response.interact_pointer_pos() {
                points[i] = ((rect.bottom() - pointer.y) / rect.height()).clamp(0.0, 1.0);
            }
        }
        let hot = response.hovered() || response.dragged();
        ui.painter().circle(at(x, points[i]), if hot { 6.0 } else { 4.5 }, ink, egui::Stroke::new(1.5, Color32::BLACK));
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
    egui::containers::menu::MenuConfig::new().close_behavior(egui::PopupCloseBehavior::CloseOnClickOutside)
}
