use super::{Kind, Title};
use canopy_ui::Place;
use forma_native::template::{self, Instance, Template, Values};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::SystemTime,
};
use tiny_skia::{Pixmap, PixmapPaint, Transform};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormaTitle {
    pub path: PathBuf,
    #[serde(default, skip_serializing_if = "Values::is_empty")]
    pub fields: Values,
}

pub struct FormaPreview {
    input: FormaTitle,
    modified: Option<SystemTime>,
    instance: Result<Instance, String>,
    fields: Vec<template::Editable>,
}

pub struct FormaFrame {
    pub pixels: Pixmap,
    pub bounds: Option<[f32; 4]>,
    pub waiting: bool,
}

pub fn catalog(folder: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut paths: Vec<_> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case(template::EXTENSION))
        })
        .collect();
    paths.sort_by(|a, b| a.file_stem().cmp(&b.file_stem()));
    paths
}

fn place(cache: &Path) -> Place {
    Place {
        space: None,
        projects_dir: cache.into(),
        data_dir: cache.into(),
        exports_dir: cache.into(),
    }
}

pub fn load_forma(path: &Path, cache: &Path) -> Result<Template, String> {
    if !path.is_file() {
        return Err("The Forma template file is missing.".into());
    }
    template::load(path, &place(cache))
}

pub(super) fn instance(title: &FormaTitle, cache: &Path) -> Result<Instance, String> {
    load_forma(&title.path, cache)?.instantiate(&title.fields, &place(cache))
}

impl FormaPreview {
    pub fn modified(title: &FormaTitle) -> Option<SystemTime> {
        std::fs::metadata(&title.path)
            .and_then(|meta| meta.modified())
            .ok()
    }

    pub fn load(title: &FormaTitle, modified: Option<SystemTime>, cache: &Path) -> Self {
        let mut fields = Vec::new();
        let instance = load_forma(&title.path, cache).and_then(|loaded| {
            fields = loaded.fields().to_vec();
            loaded.instantiate(&title.fields, &place(cache))
        });
        Self {
            input: title.clone(),
            modified,
            instance,
            fields,
        }
    }

    pub fn fields(&self) -> &[template::Editable] {
        &self.fields
    }
    pub fn error(&self) -> Option<&str> {
        self.instance.as_ref().err().map(String::as_str)
    }

    pub fn matches(&self, title: &FormaTitle, modified: Option<SystemTime>) -> bool {
        self.input == *title && self.modified == modified
    }

    pub fn render(&self, title: &Title, time: f64, w: u32, h: u32) -> Option<FormaFrame> {
        let (pixels, waiting) = render_on_canvas(title, &self.instance, w, h, |instance, size| {
            instance.preview_frame(time, size)
        })?;
        Some(FormaFrame {
            bounds: alpha_bounds(&pixels),
            pixels,
            waiting,
        })
    }
}

pub fn render_forma(
    title: &Title,
    instance: &Result<Instance, String>,
    time: f64,
    w: u32,
    h: u32,
) -> Option<Pixmap> {
    render_on_canvas(title, instance, w, h, |instance, size| {
        instance
            .render_frame(time, size)
            .map(|pixels| (pixels, false))
    })
    .map(|(pixels, _)| pixels)
}

fn render_on_canvas(
    title: &Title,
    instance: &Result<Instance, String>,
    w: u32,
    h: u32,
    draw: impl FnOnce(&Instance, (u32, u32)) -> Result<(Pixmap, bool), String>,
) -> Option<(Pixmap, bool)> {
    let mut canvas = Pixmap::new(w, h)?;
    let mut waiting = false;
    if let Some((pixels, x, y, pending)) = instance
        .as_ref()
        .ok()
        .and_then(|instance| {
            let (cw, ch) = instance.size();
            let scale = ((w as f32 / cw as f32).min(h as f32 / ch as f32) * title.size / 0.09)
                .clamp(0.01, 8.0);
            let size = (
                (cw as f32 * scale).round().clamp(1.0, 8192.0) as u32,
                (ch as f32 * scale).round().clamp(1.0, 8192.0) as u32,
            );
            let x = (title.x * w as f32 - size.0 as f32 / 2.0).round() as i32;
            let y = (title.y * h as f32 - size.1 as f32 / 2.0).round() as i32;
            draw(instance, size)
                .ok()
                .map(|(pixels, waiting)| (pixels, x, y, waiting))
        })
        .or_else(|| {
            let mut missing = title.clone();
            let (mut look, _, _, _, _) = Kind::LowerThird.start();
            look.in_secs = 0.0;
            look.out_secs = 0.0;
            look.subtitle = title.text.clone();
            missing.look = Some(look);
            missing.text = "Forma template unavailable".into();
            missing.start = 0.0;
            missing.end = 4.0;
            missing.size = 0.06;
            super::render(&missing, 2.0, w, h)
                .map(|(x, y, pixels)| (pixels, x as i32, y as i32, false))
        })
    {
        waiting = pending;
        canvas.draw_pixmap(
            x,
            y,
            pixels.as_ref(),
            &PixmapPaint::default(),
            Transform::identity(),
            None,
        );
    }
    Some((canvas, waiting))
}

fn alpha_bounds(canvas: &Pixmap) -> Option<[f32; 4]> {
    let (w, h) = (canvas.width() as usize, canvas.height() as usize);
    let [mut left, mut top, mut right, mut bottom] = [w, h, 0, 0];
    for (y, row) in canvas.pixels().chunks_exact(w).enumerate() {
        if let Some(x) = row.iter().position(|pixel| pixel.alpha() > 8) {
            left = left.min(x);
            right = right.max(
                w - row
                    .iter()
                    .rev()
                    .position(|pixel| pixel.alpha() > 8)
                    .unwrap_or(0),
            );
            top = top.min(y);
            bottom = y + 1;
        }
    }
    (right > left).then_some([
        left as f32 / w as f32,
        top as f32 / h as f32,
        right as f32 / w as f32,
        bottom as f32 / h as f32,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unavailable_template_draws_a_placeholder_with_alpha() {
        let mut project = crate::project::Project::new("Test");
        let id = project.add_title(0.0);
        let title = project.title_mut(&id).unwrap();
        title.text = "Opening title".into();
        let source = FormaTitle {
            path: PathBuf::from("no-such-forma-template.formatemplate"),
            fields: Values::new(),
        };
        title.forma = Some(source.clone());
        let preview = FormaPreview::load(&source, None, Path::new(""));
        assert!(
            preview
                .error()
                .is_some_and(|error| error.contains("missing"))
        );
        let preview = preview.render(title, 0.0, 320, 180).unwrap();
        assert!(preview.bounds.is_some());
        assert!(
            preview
                .pixels
                .pixels()
                .iter()
                .any(|pixel| pixel.alpha() > 200)
        );
        assert_eq!(preview.pixels.pixel(0, 0).unwrap().alpha(), 0);
    }
}
