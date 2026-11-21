//! The Codex panel, at the right of StreamCuts' pane: a chat with Codex about the open project. "Edit my video" asks
//! for a full edit; anything typed asks for a change (or a question); each answer is carried out at once as one undo
//! step and said in the chat. The transcript Codex reads can be worked out again ("Refresh transcript"), its keys for
//! GIPHY, Pixabay and Freesound and the sound folder are set here, and "Find shorts" looks for moments to cut out as
//! 9:16 shorts. The chat (and Codex's side of the conversation) is kept per project in the app's data folder.

use super::*;
use crate::autoedit;
use crate::codex::{self, Plan};
use crate::project::Media;
use crate::speech::{self, Spoken};
use crate::stock::{self, Keys};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::sync::mpsc::{Receiver, channel};

const FULL_EDIT: &str = "Edit this video properly: cut the dead air, false starts and boring bits; add GIFs, pictures, sound effects and titles where they fit; and give the cuts transitions.";
const WIDTH: f32 = 380.0;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
struct Settings {
    keys: Keys,
    model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Message {
    mine: bool,
    text: String,
    #[serde(default)]
    notes: Vec<String>,
    #[serde(default)]
    problems: Vec<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct Saved {
    thread: Option<String>,
    messages: Vec<Message>,
}

enum Ask {
    Edit(String),
    Shorts(String),
    Refresh,
}

enum Finished {
    Edited {
        project: String,
        thread: Option<String>,
        plan: Plan,
        fetched: HashMap<usize, Result<(Media, String), String>>,
        words: Vec<Spoken>,
    },
    Shorts {
        media: String,
        result: Result<Vec<Suggestion>, String>,
    },
    Transcribed(Result<usize, String>),
    Failed(String),
}

struct Running {
    status: Arc<Mutex<String>>,
    started: Instant,
    stopper: codex::Stopper,
    done: Receiver<Finished>,
}

#[derive(Default)]
pub(super) struct CodexPanel {
    pub(super) open: bool,
    /// The project whose chat is loaded.
    loaded: Option<String>,
    saved: Saved,
    settings: Option<Settings>,
    input: String,
    show_settings: bool,
    show_transcript: bool,
    running: Option<Running>,
    /// The timeline's words as last worked out, and for which edit.
    words: Vec<Spoken>,
    words_for: Option<(String, Option<Instant>)>,
    focus_input: bool,
}

fn folder(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("codex")
}

impl StreamCuts {
    fn codex_dir(&self) -> PathBuf {
        folder(&self.place.data_dir).join(&self.project.id)
    }

    /// Where Codex's downloads for this project go: beside the project, so they travel with it.
    fn codex_assets(&self) -> PathBuf {
        let name = canopy_ui::canopy_core::files::safe_file_name(&self.project.name);
        self.place.projects_dir.join("Codex assets").join(format!("{name}--{}", &self.project.id[..8]))
    }

    fn codex_settings(&mut self) -> Settings {
        if self.codex.settings.is_none() {
            let loaded: Settings = std::fs::read(folder(&self.place.data_dir).join("settings.json"))
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or_default();
            self.codex.settings = Some(loaded);
        }
        let mut settings = self.codex.settings.clone().unwrap();
        if settings.model.is_empty() {
            settings.model = codex::DEFAULT_MODEL.into();
        }
        settings
    }

    fn save_codex_settings(&self) {
        if let Some(settings) = &self.codex.settings {
            let dir = folder(&self.place.data_dir);
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(dir.join("settings.json"), serde_json::to_vec_pretty(settings).unwrap_or_default());
        }
    }

    /// Loads this project's chat when the project changed.
    fn codex_load(&mut self) {
        if self.codex.loaded.as_deref() == Some(self.project.id.as_str()) {
            return;
        }
        self.codex.saved = std::fs::read(self.codex_dir().join("chat.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        self.codex.loaded = Some(self.project.id.clone());
        self.codex.words_for = None;
    }

    fn codex_save(&self) {
        let dir = self.codex_dir();
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("chat.json"), serde_json::to_vec_pretty(&self.codex.saved).unwrap_or_default());
    }

    pub(super) fn codex_toggle(&mut self) {
        self.codex.open = !self.codex.open;
        if self.codex.open {
            self.codex_load();
            self.codex.focus_input = true;
        }
    }

    /// Sends something to Codex (or transcribes again) on a thread of its own.
    fn codex_start(&mut self, ask: Ask, ctx: &egui::Context) {
        if self.codex.running.is_some() {
            return;
        }
        self.codex_load();
        let settings = self.codex_settings();
        let project = self.project.clone();
        let data_dir = self.place.data_dir.clone();
        let assets = self.codex_assets();
        let dir = self.codex_dir();
        let thread = self.codex.saved.thread.clone();
        match &ask {
            Ask::Edit(text) => self.codex.saved.messages.push(Message { mine: true, text: text.clone(), notes: vec![], problems: vec![] }),
            Ask::Shorts(_) => self.codex.saved.messages.push(Message { mine: true, text: "Find shorts in this video.".into(), notes: vec![], problems: vec![] }),
            Ask::Refresh => {}
        }
        self.codex_save();
        let status = Arc::new(Mutex::new("Starting".to_string()));
        let stopper = codex::Stopper::default();
        let (send, done) = channel();
        let (worker_status, worker_stopper, ctx) = (status.clone(), stopper.clone(), ctx.clone());
        std::thread::spawn(move || {
            let progress = |text: String| {
                if let Ok(mut s) = worker_status.lock() {
                    *s = text;
                }
                ctx.request_repaint();
            };
            let finished = work(ask, &project, &data_dir, &assets, &dir, &settings, thread, &progress, &worker_stopper);
            let _ = send.send(finished);
            ctx.request_repaint();
        });
        self.codex.running = Some(Running { status, started: Instant::now(), stopper, done });
    }

    /// Takes in what Codex sent back: an edit to carry out, shorts to show, or a fresh transcript.
    pub(super) fn codex_poll(&mut self) {
        let Some(running) = &self.codex.running else { return };
        let Ok(finished) = running.done.try_recv() else { return };
        self.codex.running = None;
        self.codex_load();
        let say = |saved: &mut Saved, text: String, notes: Vec<String>, problems: Vec<String>| {
            saved.messages.push(Message { mine: false, text, notes, problems })
        };
        match finished {
            Finished::Edited { project, thread, plan, fetched, words } => {
                if thread.is_some() {
                    self.codex.saved.thread = thread;
                }
                if project != self.project.id {
                    self.toasts.push("Codex's edit was for another project; open it and ask again".into());
                    return;
                }
                let changes = !plan.operations.is_empty() || plan.transition_for_bare_cuts.is_some();
                let mut notes = Vec::new();
                let mut problems = Vec::new();
                if changes {
                    let before = self.project.clone();
                    let report = autoedit::apply(&mut self.project, &plan, &fetched, &words);
                    if self.project != before {
                        self.history.record(&before);
                        self.timeline.selection = report.added.clone();
                        self.request_looks();
                        self.edited();
                        notes.extend(report.done);
                        notes.push("Ctrl+Z takes it all back.".into());
                    }
                    if !report.credits.is_empty() {
                        notes.push(format!("From: {}.", report.credits.join("; ")));
                    }
                    problems = report.problems;
                }
                say(&mut self.codex.saved, plan.reply, notes, problems);
            }
            Finished::Shorts { media, result } => match result {
                Ok(suggestions) if !suggestions.is_empty() => {
                    let n = suggestions.len();
                    self.boss_plan = Some(BossPlan { media_id: media, suggestions });
                    say(&mut self.codex.saved, format!("Found {n} short{}: pick one to open it as a 9:16 project.", if n == 1 { "" } else { "s" }), vec![], vec![]);
                }
                Ok(_) => say(&mut self.codex.saved, "I didn't find any moments that would work as shorts.".into(), vec![], vec![]),
                Err(e) => say(&mut self.codex.saved, String::new(), vec![], vec![e]),
            },
            Finished::Transcribed(result) => {
                self.codex.words_for = None;
                match result {
                    Ok(n) => say(&mut self.codex.saved, format!("Transcript refreshed: {n} words. I'll use it from your next message."), vec![], vec![]),
                    Err(e) => say(&mut self.codex.saved, String::new(), vec![], vec![e]),
                }
            }
            Finished::Failed(e) => say(&mut self.codex.saved, String::new(), vec![], vec![e]),
        }
        self.codex_save();
    }

    /// The timeline's words, worked out again after an edit.
    fn codex_words(&mut self) -> &[Spoken] {
        let key = (self.project.id.clone(), self.edited_at);
        if self.codex.words_for.as_ref() != Some(&key) {
            self.codex.words = speech::timeline_words(&self.place.data_dir, &self.project, &self.codex_assets());
            self.codex.words_for = Some(key);
        }
        &self.codex.words
    }

    pub(super) fn codex_window(&mut self, ui: &mut Ui) {
        if !self.codex.open {
            return;
        }
        self.codex_load();
        let pane = if self.pane.is_positive() { self.pane } else { ui.ctx().content_rect() };
        let width = WIDTH.min(pane.width() - 24.0).max(260.0);
        let rect = Rect::from_min_max(
            pos2(pane.right() - width - 10.0, pane.top() + 54.0),
            pos2(pane.right() - 10.0, pane.bottom() - 10.0),
        );
        let ctx = ui.ctx().clone();
        egui::Area::new(ui.scope_id().with("codex-panel"))
            .order(egui::Order::Foreground)
            .fixed_pos(rect.min)
            .constrain(false)
            .show(&ctx, |ui| {
                ui.set_max_size(rect.size());
                egui::Frame::new()
                    .fill(Mood::Ember.pane())
                    .stroke(Stroke::new(1.0, color::HAIRLINE_STRONG))
                    .corner_radius(12)
                    .shadow(egui::epaint::Shadow { offset: [0, 6], blur: 24, spread: 0, color: color::SHADOW })
                    .inner_margin(12)
                    .show(ui, |ui| {
                        ui.set_width(rect.width() - 24.0);
                        ui.set_min_height(rect.height() - 24.0);
                        self.codex_contents(ui, rect.height() - 24.0);
                    });
            });
    }

    fn codex_contents(&mut self, ui: &mut Ui, height: f32) {
        let ctx = ui.ctx().clone();
        let busy = self.codex.running.is_some();
        // Header.
        ui.horizontal(|ui| {
            ui.label(egui::RichText::new("Codex").font(font::display(20.0)).color(color::INK));
            ui.label(canopy_ui::muted("edits with you"));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if icon_button(ui, Icon::Close, "Close (Alt+B)", false).clicked() {
                    self.codex.open = false;
                }
                if quiet_button(ui, "Settings", None).clicked() {
                    self.codex.show_settings = !self.codex.show_settings;
                }
            });
        });
        ui.add_space(4.0);
        if self.codex.show_settings {
            self.codex_settings_ui(ui);
            ui.separator();
        }
        // The transcript Codex reads.
        let words = self.codex_words().len();
        let assets = self.codex_assets();
        let needed = speech::needed(&self.project, &assets);
        let to_do = speech::to_do(&self.place.data_dir, &needed, false);
        ui.horizontal_wrapped(|ui| {
            ui.label(egui::RichText::new("Transcript").color(color::INK_SOFT));
            let summary = if needed.is_empty() {
                "nothing with speech on the timeline".to_string()
            } else if to_do > 0.5 && words == 0 {
                "not made yet; it's made when you ask".to_string()
            } else if to_do > 0.5 {
                format!("{words} words, {} not heard yet", clock(to_do))
            } else {
                format!("{words} words")
            };
            ui.label(canopy_ui::muted(summary));
            if ui.add_enabled(!busy && !needed.is_empty(), egui::Button::new("Refresh transcript"))
                .on_hover_text("Work out what's said again, from the sound, and give Codex the new one")
                .clicked()
            {
                self.codex_start(Ask::Refresh, &ctx);
            }
            if words > 0 && ui.selectable_label(self.codex.show_transcript, "Show").clicked() {
                self.codex.show_transcript = !self.codex.show_transcript;
            }
        });
        if self.codex.show_transcript && words > 0 {
            let lines = speech::lines(&self.codex.words);
            let mut seek = None;
            egui::Frame::new().fill(color::VEIL).corner_radius(8).inner_margin(6).show(ui, |ui| {
                egui::ScrollArea::vertical().id_salt("codex-transcript").max_height(150.0).show(ui, |ui| {
                    for (start, _, text) in lines {
                        let line = ui.add(
                            egui::Label::new(egui::RichText::new(format!("{}  {text}", timecode(start, self.project.fps))).size(12.0))
                                .wrap()
                                .sense(Sense::click()),
                        );
                        if line.on_hover_text("Go there").clicked() {
                            seek = Some(start);
                        }
                    }
                });
            });
            if let Some(t) = seek {
                self.seek(t);
            }
        }
        ui.add_space(6.0);
        ui.horizontal(|ui| {
            if ui.add_enabled(!busy, egui::Button::new("Edit my video")).on_hover_text(FULL_EDIT).clicked() {
                self.codex_start(Ask::Edit(FULL_EDIT.into()), &ctx);
            }
            if ui.add_enabled(!busy, egui::Button::new("Find shorts"))
                .on_hover_text("Look through the main video for moments that would make good 9:16 shorts")
                .clicked()
            {
                let media = self.shorts_media();
                match media {
                    Some(id) => self.codex_start(Ask::Shorts(id), &ctx),
                    None => self.toasts.push("Import a video to find shorts".into()),
                }
            }
            if !self.codex.saved.messages.is_empty()
                && ui.add_enabled(!busy, egui::Button::new("New chat"))
                    .on_hover_text("Start over: Codex forgets this conversation (your edits stay)")
                    .clicked()
            {
                self.codex.saved = Saved::default();
                self.codex_save();
            }
        });
        ui.separator();
        // The chat, then the box to type in.
        let input_height = 96.0;
        let chat_height = (height - ui.min_rect().height() - input_height).max(120.0);
        egui::ScrollArea::vertical()
            .id_salt("codex-chat")
            .max_height(chat_height)
            .min_scrolled_height(chat_height)
            .stick_to_bottom(true)
            .auto_shrink([false, false])
            .show(ui, |ui| {
                if self.codex.saved.messages.is_empty() {
                    ui.label(canopy_ui::muted(
                        "Ask Codex to edit the video (\"Edit my video\" does the lot), or for any change: \"cut the part about the village\", \"put a vine boom on every death\", \"no more GIFs after 5:00\".",
                    ));
                }
                for message in &self.codex.saved.messages {
                    let (fill, align) = if message.mine {
                        (color::SELECT_FILL, egui::Align::Max)
                    } else {
                        (color::VEIL, egui::Align::Min)
                    };
                    ui.with_layout(egui::Layout::top_down(align), |ui| {
                        egui::Frame::new().fill(fill).corner_radius(10).inner_margin(8).show(ui, |ui| {
                            ui.set_max_width(ui.available_width() * 0.9);
                            if !message.text.is_empty() {
                                ui.add(egui::Label::new(egui::RichText::new(&message.text).color(color::INK)).wrap());
                            }
                            for note in &message.notes {
                                ui.add(egui::Label::new(egui::RichText::new(format!("• {note}")).size(12.5).color(color::INK_SOFT)).wrap());
                            }
                            for problem in &message.problems {
                                ui.add(egui::Label::new(egui::RichText::new(format!("• {problem}")).size(12.5).color(color::DANGER)).wrap());
                            }
                        });
                    });
                    ui.add_space(6.0);
                }
                if let Some(running) = &self.codex.running {
                    let status = running.status.lock().map(|s| s.clone()).unwrap_or_default();
                    let elapsed = running.started.elapsed().as_secs();
                    ui.horizontal(|ui| {
                        ui.add(egui::Spinner::new());
                        ui.label(canopy_ui::muted(format!("{status} · {}:{:02}", elapsed / 60, elapsed % 60)));
                    });
                    ctx.request_repaint_after(Duration::from_millis(500));
                }
            });
        ui.add_space(6.0);
        let input_id = ui.scope_id().with("codex-input");
        let had_focus = ui.memory(|m| m.has_focus(input_id));
        let enter = had_focus && ui.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Enter));
        let edit = ui.add_sized(
            [ui.available_width(), 52.0],
            egui::TextEdit::multiline(&mut self.codex.input)
                .id(input_id)
                .hint_text("Tell Codex what to change (Enter sends, Shift+Enter for a new line)")
                .desired_rows(2),
        );
        if self.codex.focus_input {
            edit.request_focus();
            self.codex.focus_input = false;
        }
        ui.horizontal(|ui| {
            if let Some(running) = &self.codex.running {
                if ui.button("Stop").clicked() {
                    running.stopper.stop();
                }
            } else {
                let text = self.codex.input.trim().to_string();
                let send = ui.add_enabled(!text.is_empty(), egui::Button::new("Send")).clicked() || (enter && !text.is_empty());
                if send {
                    self.codex.input.clear();
                    self.codex_start(Ask::Edit(text), &ctx);
                    self.codex.focus_input = true;
                }
            }
            let settings = self.codex_settings();
            if !settings.keys.giphy.trim().is_empty() {
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(egui::RichText::new("Powered by GIPHY").size(11.0).color(color::INK_FAINT));
                });
            }
        });
    }

    fn codex_settings_ui(&mut self, ui: &mut Ui) {
        let mut settings = self.codex_settings();
        let before = settings.clone();
        egui::Grid::new("codex-settings").num_columns(2).spacing(vec2(8.0, 6.0)).show(ui, |ui| {
            ui.label("Model");
            let models = codex::models();
            egui::ComboBox::from_id_salt("codex-model").selected_text(&settings.model).show_ui(ui, |ui| {
                for model in models {
                    ui.selectable_value(&mut settings.model, model.clone(), model);
                }
            });
            ui.end_row();
            for (label, key, hint) in [
                ("GIPHY key", &mut settings.keys.giphy, "for GIFs and stickers"),
                ("Pixabay key", &mut settings.keys.pixabay, "for pictures and stock video"),
                ("Freesound key", &mut settings.keys.freesound, "for sound effects"),
            ] {
                ui.label(label);
                ui.add(egui::TextEdit::singleline(key).password(true).hint_text(hint).desired_width(200.0));
                ui.end_row();
            }
            ui.label("Sound folder");
            ui.horizontal(|ui| {
                let shown = settings.keys.sounds.as_ref().map_or("None".to_string(), |p| {
                    p.file_name().map_or(p.display().to_string(), |n| n.to_string_lossy().into_owned())
                });
                ui.label(canopy_ui::muted(shown));
                if ui.button("Choose…").clicked() {
                    if let Some(dir) = rfd::FileDialog::new().set_title("Your sound effects folder").pick_folder() {
                        settings.keys.sounds = Some(dir);
                    }
                }
                if settings.keys.sounds.is_some() && ui.button("Clear").clicked() {
                    settings.keys.sounds = None;
                }
            });
            ui.end_row();
        });
        ui.label(canopy_ui::muted("Keys stay on this computer, in StreamCuts' own data folder."));
        if settings != before {
            self.codex.settings = Some(settings);
            self.save_codex_settings();
        }
    }

    /// The video to find shorts in: the selected clip's, else the one with the most time on the timeline.
    fn shorts_media(&self) -> Option<String> {
        let selected = self.timeline.selection.iter().find_map(|id| self.project.clip(id)).map(|c| c.media_id.clone());
        selected.filter(|id| self.project.media(id).is_some_and(|m| m.kind == MediaKind::Video)).or_else(|| {
            let mut time: HashMap<&str, f64> = HashMap::new();
            for clip in self.project.tracks.iter().flat_map(|t| t.clips.iter()) {
                if self.project.media(&clip.media_id).is_some_and(|m| m.kind == MediaKind::Video) {
                    *time.entry(clip.media_id.as_str()).or_default() += clip.duration;
                }
            }
            time.into_iter().max_by(|a, b| a.1.total_cmp(&b.1)).map(|(id, _)| id.to_owned())
        })
    }
}

fn clock(seconds: f64) -> String {
    let s = seconds.round() as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

/// What the person's keys allow, told to Codex.
fn services(keys: &Keys) -> String {
    let mut out = Vec::new();
    out.push(if keys.giphy.trim().is_empty() { "No GIPHY key: don't use gif." } else { "GIFs and stickers: GIPHY." });
    out.push(if keys.pixabay.trim().is_empty() {
        "No Pixabay key: don't use picture or stock_video."
    } else {
        "Pictures and stock video: Pixabay."
    });
    out.push(match (keys.sounds.is_some(), !keys.freesound.trim().is_empty()) {
        (true, true) => "Sounds: the person's folder first (use a file's exact name), else Freesound.",
        (true, false) => "Sounds: only the person's folder (use a file's exact name).",
        (false, true) => "Sounds: Freesound.",
        (false, false) => "No sounds: don't use sound.",
    });
    out.join(" ")
}

/// Does what was asked, off the UI thread.
#[allow(clippy::too_many_arguments)]
fn work(
    ask: Ask,
    project: &Project,
    data_dir: &std::path::Path,
    assets: &std::path::Path,
    dir: &std::path::Path,
    settings: &Settings,
    thread: Option<String>,
    progress: &dyn Fn(String),
    stopper: &codex::Stopper,
) -> Finished {
    match ask {
        Ask::Refresh => {
            let needed = speech::needed(project, assets);
            Finished::Transcribed(
                speech::transcribe(data_dir, &needed, true, progress)
                    .map(|_| speech::timeline_words(data_dir, project, assets).len())
                    .map_err(|e| format!("Couldn't transcribe: {e}")),
            )
        }
        Ask::Edit(text) => {
            let needed = speech::needed(project, assets);
            if speech::to_do(data_dir, &needed, false) > 0.5 {
                progress("Transcribing (only the first time)".into());
                if let Err(e) = speech::transcribe(data_dir, &needed, false, progress) {
                    return Finished::Failed(format!("Couldn't transcribe: {e}"));
                }
            }
            let words = speech::timeline_words(data_dir, project, assets);
            let sounds: Vec<String> = settings
                .keys
                .sounds
                .as_deref()
                .map(|folder| {
                    stock::sound_files(folder)
                        .iter()
                        .take(400)
                        .map(|p| p.file_name().unwrap_or_default().to_string_lossy().into_owned())
                        .collect()
                })
                .unwrap_or_default();
            let noises = speech::timeline_noises(data_dir, project, assets);
            let state = codex::describe(project, &words, &noises, &sounds);
            let prompt = if thread.is_none() {
                format!("{}\n\n{state}\n# The person says\n{text}", codex::instructions(&services(&settings.keys)))
            } else {
                format!(
                    "(Here's the project as it is now; it may have changed since your last answer. Keys: {})\n\n{state}\n# The person says\n{text}",
                    services(&settings.keys)
                )
            };
            progress("Asking Codex".into());
            let (thread, answer) = match codex::ask(&prompt, thread.as_deref(), &settings.model, dir, &codex::schema(), progress, stopper) {
                Ok(answer) => answer,
                Err(e) => return Finished::Failed(e),
            };
            let plan: Plan = match codex::parse(&answer) {
                Ok(plan) => plan,
                Err(e) => return Finished::Failed(e),
            };
            let wants = autoedit::wants(&plan);
            let mut fetched = HashMap::new();
            for (n, (index, want, query)) in wants.iter().enumerate() {
                progress(format!("Getting {} {}/{}: {query}", match want {
                    stock::Want::Gif { .. } => "a GIF",
                    stock::Want::Picture => "a picture",
                    stock::Want::StockVideo => "a stock video",
                    stock::Want::Sound { .. } => "a sound",
                }, n + 1, wants.len()));
                let result = stock::find(*want, query, &settings.keys, assets)
                    .and_then(|found| crate::ffmpeg::probe(&found.path).map(|media| (media, found.credit)));
                fetched.insert(*index, result);
            }
            Finished::Edited { project: project.id.clone(), thread, plan, fetched, words }
        }
        Ask::Shorts(media_id) => {
            let Some(media) = project.media(&media_id) else {
                return Finished::Failed("That video isn't in the project any more.".into());
            };
            let needed = vec![(media.path.clone(), vec![(0.0, media.duration)])];
            if speech::to_do(data_dir, &needed, false) > 0.5 {
                progress("Transcribing the whole video (only the first time)".into());
                if let Err(e) = speech::transcribe(data_dir, &needed, false, progress) {
                    return Finished::Failed(format!("Couldn't transcribe: {e}"));
                }
            }
            // Its words in source seconds: a clip of all of it, on its own.
            let mut whole = Project::new("shorts");
            whole.media.push(media.clone());
            if let Some(id) = whole.place(&media.id, None, 0.0) {
                if let Some(c) = whole.clip_mut(&id) {
                    c.duration = media.duration;
                }
            }
            let words = speech::timeline_words(data_dir, &whole, assets);
            let lines: Vec<String> = speech::lines(&words).into_iter().map(|(s, e, t)| format!("[{s:.1}-{e:.1}] {t}")).collect();
            let prompt = format!(
                "Find strong, self-contained moments in this video that would work as 9:16 shorts: up to three for each ten minutes of it, each 15-90 seconds, starting and ending on whole sentences, with a punchy 3-5 word title and a one-sentence description. Times are seconds in the video. Answer in the given JSON shape.\n\nThe video \"{}\" ({:.0} s). What's said:\n{}",
                media.name,
                media.duration,
                lines.join("\n")
            );
            progress("Asking Codex for shorts".into());
            #[derive(Deserialize)]
            struct Shorts {
                shorts: Vec<Suggestion>,
            }
            let result = codex::ask(&prompt, None, &settings.model, &dir.join("shorts"), &codex::shorts_schema(), progress, stopper)
                .and_then(|(_, text)| codex::parse::<Shorts>(&text))
                .map(|found| {
                    found
                        .shorts
                        .into_iter()
                        .filter_map(|mut s| {
                            s.start_seconds = s.start_seconds.max(0.0);
                            s.end_seconds = s.end_seconds.min(media.duration);
                            let length = s.end_seconds - s.start_seconds;
                            ((4.0..=92.0).contains(&length) && !s.title.trim().is_empty()).then_some(s)
                        })
                        .collect()
                });
            Finished::Shorts { media: media_id, result }
        }
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// The whole thing for real on a video named by STREAMCUTS_CODEX_CHECK_VIDEO: transcribe it, ask Codex for a full
    /// edit (sounds from the folder in STREAMCUTS_CODEX_CHECK_SOUNDS), carry it out, and save the project to
    /// STREAMCUTS_CODEX_CHECK_OUT. Run with --ignored --nocapture.
    #[test]
    #[ignore]
    fn codex_edits_a_real_video() {
        let video = PathBuf::from(std::env::var("STREAMCUTS_CODEX_CHECK_VIDEO").expect("STREAMCUTS_CODEX_CHECK_VIDEO"));
        let out = PathBuf::from(std::env::var("STREAMCUTS_CODEX_CHECK_OUT").expect("STREAMCUTS_CODEX_CHECK_OUT"));
        let data = out.join("data");
        let mut project = Project::new("Codex check");
        let media = project.add_media(crate::ffmpeg::probe(&video).unwrap());
        project.place(&media, Some(0), 0.0).unwrap();
        let settings = Settings {
            keys: Keys { sounds: std::env::var_os("STREAMCUTS_CODEX_CHECK_SOUNDS").map(PathBuf::from), ..Keys::default() },
            model: codex::DEFAULT_MODEL.into(),
        };
        let progress = |s: String| println!("  {s}");
        let finished = work(Ask::Edit(FULL_EDIT.into()), &project, &data, &out.join("assets"), &out.join("codex"), &settings, None, &progress, &codex::Stopper::default());
        let Finished::Edited { plan, fetched, words, thread, .. } = finished else { panic!("not an edit") };
        println!("thread {thread:?}, {} words\nreply: {}\n{} operations", words.len(), plan.reply, plan.operations.len());
        for op in &plan.operations {
            println!("  {:?} start {:?} end {:?} {:?} {:?} {:?}", op.kind, op.start, op.end, op.query, op.text, op.style);
        }
        let before = project.duration();
        let report = autoedit::apply(&mut project, &plan, &fetched, &words);
        println!("{report:#?}\n{before:.1} s -> {:.1} s", project.duration());
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join("edited.streamcuts.json"), serde_json::to_vec_pretty(&project).unwrap()).unwrap();
        assert!(words.len() > 100);
        assert!(!plan.operations.is_empty());
    }
}
