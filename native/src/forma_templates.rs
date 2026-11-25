use super::*;
use crate::{
    project::Title,
    template::{self, FormaPreview, FormaTitle},
};
use forma_native::template::{self as forma, Value, Values};
use std::{path::Path, time::SystemTime};

impl StreamCuts {
    pub(super) fn is_forma_template(path: &Path) -> bool {
        path.extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case(forma::EXTENSION))
    }

    pub(super) fn receive_forma(&mut self, path: PathBuf, host: &mut dyn Host) {
        if !self.received_forma.contains(&path) {
            self.received_forma.push(path);
        }
        host.toast("Forma template available under Templates › From Forma".into());
    }

    pub(super) fn forma_preview(
        &mut self,
        id: &str,
        title: &FormaTitle,
        modified: Option<SystemTime>,
    ) -> &FormaPreview {
        let cache = self.place.data_dir.join("forma-templates");
        let entry = self
            .forma_templates
            .entry(id.to_owned())
            .or_insert_with(|| FormaPreview::load(title, modified, &cache));
        if !entry.matches(title, modified) {
            *entry = FormaPreview::load(title, modified, &cache);
        }
        entry
    }

    pub(super) fn forma_templates_menu(&mut self, ui: &mut Ui) {
        let mut paths = template::catalog(&self.place.exports_dir);
        for path in &self.received_forma {
            if !paths.contains(path) {
                paths.push(path.clone());
            }
        }
        ui.separator();
        ui.label(
            egui::RichText::new("From Forma")
                .font(font::ui(12.0))
                .color(color::INK_MUTED),
        );
        if paths.is_empty() {
            ui.label(canopy_ui::muted(
                "Send a template from Forma to see it here.",
            ));
        }
        egui::ScrollArea::vertical()
            .id_salt("forma-templates")
            .max_height(180.0)
            .show(ui, |ui| {
                for path in paths {
                    let name = path.file_stem().unwrap_or_default().to_string_lossy();
                    if canopy_ui::quiet_button(ui, &name, None).clicked() {
                        self.add_forma_template(path);
                        ui.close();
                        break;
                    }
                }
            });
    }

    fn add_forma_template(&mut self, path: PathBuf) {
        let cache = self.place.data_dir.join("forma-templates");
        let label = path.file_stem().unwrap_or_default().to_string_lossy();
        let (name, duration) = template::load_forma(&path, &cache).map_or_else(
            |_| (label.into_owned(), 4.0),
            |template| (template.name().to_owned(), template.duration()),
        );
        self.history.record(&self.project);
        let id = self.project.add_title(self.playhead);
        if let Some(title) = self.project.title_mut(&id) {
            title.text = name;
            title.end = title.start + duration;
            title.forma = Some(FormaTitle {
                path,
                fields: Values::new(),
            });
        }
        self.project.settle_title_rows();
        self.timeline.selection = vec![id.clone()];
        self.template_open = Some(id);
        self.edited();
    }

    pub(super) fn forma_template_window(&mut self, ui: &mut Ui, title: Title) {
        let Some(forma) = &title.forma else { return };
        let modified = FormaPreview::modified(forma);
        let preview = self.forma_preview(&title.id, forma, modified);
        let fields = preview.fields().to_vec();
        let error = preview.error().map(str::to_owned);
        let (mut edited, mut open) = (title.clone(), true);
        egui::Window::new(format!("Template from Forma · {}", title.text))
            .id(ui.scope_id().with("forma-template-window"))
            .open(&mut open)
            .collapsible(false)
            .constrain_to(ui.max_rect())
            .show(ui.ctx(), |ui| {
                let Some(forma) = &mut edited.forma else {
                    return;
                };
                if let Some(error) = error {
                    ui.label(error);
                }
                egui::ScrollArea::vertical()
                    .max_height(380.0)
                    .show(ui, |ui| {
                        for field in fields {
                            ui.push_id(&field.field.id, |ui| {
                                ui.label(&field.field.label);
                                let mut value = forma
                                    .fields
                                    .get(&field.field.id)
                                    .unwrap_or(&field.default)
                                    .clone();
                                if field_editor(ui, field.field.target, &mut value) {
                                    forma.fields.insert(field.field.id.clone(), value);
                                }
                                if forma.fields.contains_key(&field.field.id)
                                    && canopy_ui::quiet_button(ui, "Reset field", None).clicked()
                                {
                                    forma.fields.remove(&field.field.id);
                                }
                            });
                        }
                        let mut duration = edited.end - edited.start;
                        if ui
                            .add(
                                egui::DragValue::new(&mut duration)
                                    .range(0.1..=86400.0)
                                    .prefix("Shows for ")
                                    .suffix(" s")
                                    .speed(0.1),
                            )
                            .changed()
                        {
                            edited.end = edited.start + duration;
                        }
                    });
            });
        if edited != title {
            if !self.adjusting {
                self.history.record(&self.project);
                self.adjusting = true;
            }
            if let Some(target) = self.project.title_mut(&title.id) {
                *target = edited;
            }
            self.project.settle_title_rows();
            self.edited();
        }
        if !ui.input(|i| i.pointer.any_down()) && !ui.ctx().egui_wants_keyboard_input() {
            self.adjusting = false;
        }
        if !open {
            self.template_open = None;
        }
    }
}

fn field_editor(ui: &mut Ui, target: forma::Target, value: &mut Value) -> bool {
    match value {
        Value::Text(text) => {
            let changed = ui
                .add(
                    egui::TextEdit::multiline(text)
                        .char_limit(120)
                        .desired_rows(2),
                )
                .changed();
            if changed {
                let mut utf16_len = 0;
                *text = text
                    .chars()
                    .take_while(|c| {
                        utf16_len += c.len_utf16();
                        utf16_len <= 120
                    })
                    .collect();
            }
            changed
        }
        Value::Color(color) => {
            let mut rgb = template::rgb(color);
            if ui.color_edit_button_srgb(&mut rgb).changed() {
                let [r, g, b] = rgb;
                *color = format!("#{r:02x}{g:02x}{b:02x}");
                return true;
            }
            false
        }
        Value::Number(number) => {
            let range = if target == forma::Target::PlaybackSpeed {
                0.0..=100.0
            } else {
                1.0..=500.0
            };
            ui.add(egui::DragValue::new(number).range(range).speed(0.1))
                .changed()
        }
    }
}
