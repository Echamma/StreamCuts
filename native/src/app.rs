//! The StreamCuts editor: toolbar, media bin, preview with transport, and the timeline. One instance runs per space in
//! Canopy, or alone in StreamCuts' own window.

use crate::audio::Audio;
use crate::boss::Suggestion;
use crate::captions;
use crate::export::{self, Export};
use crate::ffmpeg::Frame;
use crate::preview::{Clock, Preview};
use crate::project::{Effects, ExportFormat, Framing, Grade, History, MediaKind, Picture, Project, SPEEDS};
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
    boss_plan: Option<BossPlan>,
    /// Typing in a caption: one undo step for the whole edit.
    caption_typing: bool,
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
            boss_plan: None,
            caption_typing: false,
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

    fn request_looks(&mut self) {
        for media in self.project.media.iter().filter(|m| m.path.is_file()) {
            if self.looks_asked.insert(media.id.clone()) {
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
        let mut place_now = None;
        let mut find = None;
        let mut remove = None;
        egui::ScrollArea::vertical().auto_shrink(false).show(ui, |ui| {
            for media in &self.project.media {
                let missing = !media.path.is_file();
                let id = ui.scope_id().with(("media", &media.id));
                let response = ui.dnd_drag_source(id, MediaDrag(media.id.clone()), |ui| {
                    // Clicks go to the row (click to find a missing file, double-click to place it); drags go to the drag source.
                    let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 46.0), Sense::click());
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
                    let text = painter.with_clip_rect(Rect::from_min_max(pos2(thumb.right() + 8.0, rect.top()), rect.max - vec2(6.0, 0.0)));
                    text.text(pos2(thumb.right() + 8.0, rect.top() + 8.0), Align2::LEFT_TOP, &media.name, font::ui(13.0), color::INK);
                    if missing {
                        text.text(pos2(thumb.right() + 8.0, rect.bottom() - 7.0), Align2::LEFT_BOTTOM, "Missing: click to find it", font::ui(11.0), color::SUN);
                    } else {
                        let detail = match media.kind { MediaKind::Image => format!("Picture · {}×{}", media.width, media.height), _ => timecode(media.duration, self.project.fps) };
                        text.text(pos2(thumb.right() + 8.0, rect.bottom() - 7.0), Align2::LEFT_BOTTOM, detail, font::ui(11.0), color::INK_MUTED);
                    }
                });
                let response = egui::InnerResponse { response: response.response.on_hover_text(media.info()), ..response };
                if missing && response.response.clicked() {
                    find = Some(media.id.clone());
                } else if response.response.double_clicked() {
                    place_now = Some(media.id.clone());
                }
                let used = self.project.tracks.iter().any(|t| t.clips.iter().any(|c| c.media_id == media.id));
                response.response.context_menu(|ui| {
                    if ui.add_enabled(!used, egui::Button::new("Remove from project")).on_disabled_hover_text("A clip on the timeline uses it").clicked() {
                        remove = Some(media.id.clone());
                    }
                });
                ui.add_space(2.0);
            }
        });
        if let Some(id) = find {
            self.find_media(&id);
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
            captions::draw(&over_picture, screen, &caption.text, self.project.caption_bottom);
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
        let crossfade_limit = self.project.crossfade_limit(&id);
        let mut speed = clip.speed;
        ui.add_space(6.0);
        ui.menu_button(egui::RichText::new("Clip").font(font::ui(13.0)), |ui| {
            ui.set_min_width(230.0);
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
                ui.horizontal(|ui| {
                    ui.label(egui::RichText::new("Color").font(font::ui(12.0)).color(color::INK_MUTED));
                    if !changed.grade.is_neutral() && ui.small_button("Reset").clicked() {
                        changed.grade = Grade::default();
                    }
                });
                ui.add(egui::Slider::new(&mut changed.grade.brightness, -0.5..=0.5).show_value(false).text("Brightness"));
                ui.add(egui::Slider::new(&mut changed.grade.contrast, 0.5..=2.0).show_value(false).text("Contrast"));
                ui.add(egui::Slider::new(&mut changed.grade.saturation, 0.0..=2.5).show_value(false).text("Saturation"));
                ui.separator();
                ui.horizontal(|ui| {
                    ui.label(egui::RichText::new("Effects").font(font::ui(12.0)).color(color::INK_MUTED));
                    if !changed.effects.is_neutral() && ui.small_button("Reset").clicked() {
                        changed.effects = Effects::default();
                    }
                });
                ui.add(egui::Slider::new(&mut changed.effects.blur, 0.0..=12.0).text("Blur"));
                ui.add(egui::Slider::new(&mut changed.effects.sharpen, 0.0..=2.0).text("Sharpen"));
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
    }

    /// One selected title gets its text, and a menu for its size, height and length, in the timeline bar.
    fn title_editor(&mut self, ui: &mut Ui) {
        let [id] = self.timeline.selection.as_slice() else { return };
        let Some(title) = self.project.titles.iter().find(|t| &t.id == id).cloned() else { return };
        let id = id.clone();
        let mut changed = title.clone();
        ui.add_space(10.0);
        let field = ui.add(egui::TextEdit::singleline(&mut changed.text).desired_width(ui.available_width().clamp(100.0, 260.0) - 60.0).hint_text("Title"));
        ui.menu_button(egui::RichText::new("Size & place").font(font::ui(13.0)), |ui| {
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
    }

    /// One selected clip with sound gets a volume slider in the timeline bar.
    fn volume_control(&mut self, ui: &mut Ui) {
        let [id] = self.timeline.selection.as_slice() else { return };
        let Some(clip) = self.project.clip(id) else { return };
        if !self.project.media(&clip.media_id).is_some_and(|media| media.has_audio) {
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
