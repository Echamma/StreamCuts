//! The timeline: a ruler, one row per track, clips you can move, trim and select, and the playhead.
//! It edits the project through `Project`'s methods and reports seeks and drops back to the editor.

use crate::filmstrip::Strip;
use crate::project::{History, MediaKind, Project, TrackKind};
use crate::waveform::Waveform;
use canopy_ui::{DraggedFiles, Icon, SharedFile, color, font, icon_button};
use egui::{Align2, Color32, CursorIcon, DragAndDrop, Rect, Sense, Stroke, StrokeKind, TextureHandle, Ui, UiBuilder, pos2, vec2};
use std::collections::HashMap;
use std::sync::Arc;

pub const RULER: f32 = 26.0;
pub const ROW: f32 = 64.0;
pub const HEADER: f32 = 112.0;
const EDGE: f32 = 7.0;
const SNAP_PX: f32 = 8.0;

/// A medium dragged from the media bin.
#[derive(Clone, Debug)]
pub struct MediaDrag(pub String);

/// How media looks on the timeline, made in the background: a thumbnail, a filmstrip and a waveform per media id.
#[derive(Default)]
pub struct Looks {
    pub thumbnails: HashMap<String, TextureHandle>,
    pub filmstrips: HashMap<String, Strip>,
    pub waveforms: HashMap<String, Arc<Waveform>>,
}

enum Gesture {
    Move { clip: String, grab: f64 },
    TrimStart(String),
    TrimEnd(String),
}

pub struct Timeline {
    /// Pixels per second.
    pub pps: f32,
    /// The time at the left edge of the lanes.
    pub scroll: f64,
    pub selection: Vec<String>,
    pub snap: bool,
    gesture: Option<Gesture>,
}

impl Default for Timeline {
    fn default() -> Self {
        Self { pps: 60.0, scroll: 0.0, selection: Vec::new(), snap: true, gesture: None }
    }
}

#[derive(Default)]
pub struct Output {
    pub seek: Option<f64>,
    /// Files dropped from Canopy's sidebar: import them, then place them here.
    pub dropped: Option<(Vec<SharedFile>, f64, Option<usize>)>,
    pub changed: bool,
}

fn tick_step(pps: f32) -> f64 {
    [0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0, 15.0, 30.0, 60.0, 120.0, 300.0, 600.0, 1800.0].into_iter().find(|s| s * pps as f64 >= 70.0).unwrap_or(3600.0)
}

pub fn timecode(seconds: f64, fps: u32) -> String {
    let total = seconds.max(0.0);
    let s = total.floor() as u64;
    let frames = ((total - s as f64) * fps as f64).floor() as u64;
    if s >= 3600 {
        format!("{}:{:02}:{:02}.{:02}", s / 3600, s / 60 % 60, s % 60, frames)
    } else {
        format!("{:02}:{:02}.{:02}", s / 60, s % 60, frames)
    }
}

fn clip_fill(kind: MediaKind) -> Color32 {
    match kind {
        MediaKind::Video => Color32::from_rgb(0x6E, 0x3A, 0x5E),
        MediaKind::Image => Color32::from_rgb(0x8A, 0x4B, 0x2C),
        MediaKind::Audio => Color32::from_rgb(0x22, 0x5E, 0x78),
    }
}

impl Timeline {
    fn snap(&self, project: &Project, ignore: Option<&str>, playhead: f64, t: f64) -> f64 {
        if !self.snap {
            return t;
        }
        let reach = (SNAP_PX / self.pps) as f64;
        let mut points = project.snap_points(ignore);
        points.push(playhead);
        points.into_iter().filter(|p| (p - t).abs() <= reach).min_by(|a, b| (a - t).abs().total_cmp(&(b - t).abs())).unwrap_or(t)
    }

    pub fn ui(
        &mut self,
        ui: &mut Ui,
        project: &mut Project,
        history: &mut History,
        playhead: f64,
        looks: &Looks,
    ) -> Output {
        let mut output = Output::default();
        let rect = ui.available_rect_before_wrap();
        let background = ui.allocate_rect(rect, Sense::click_and_drag());
        let painter = ui.painter_at(rect);
        let lanes = Rect::from_min_max(pos2(rect.left() + HEADER, rect.top()), rect.max);
        let (pps, scroll) = (self.pps, self.scroll);
        let x_of = |t: f64| lanes.left() + ((t - scroll) as f32) * pps;
        let t_of = |x: f32| scroll + ((x - lanes.left()) / pps) as f64;
        let row = |i: usize| Rect::from_min_size(pos2(rect.left(), rect.top() + RULER + i as f32 * ROW), vec2(rect.width(), ROW));
        let pointer = ui.input(|i| i.pointer.hover_pos());
        let row_at = |y: f32| ((y - rect.top() - RULER) / ROW).floor();

        // Ruler
        let ruler = Rect::from_min_max(pos2(lanes.left(), rect.top()), pos2(rect.right(), rect.top() + RULER));
        painter.rect_filled(ruler, 0, color::VEIL);
        let step = tick_step(pps);
        let mut t = (scroll / step).floor() * step;
        while x_of(t) < rect.right() {
            let x = x_of(t);
            if x >= lanes.left() {
                painter.line_segment([pos2(x, ruler.bottom() - 7.0), pos2(x, ruler.bottom())], Stroke::new(1.0, color::INK_FAINT));
                painter.text(pos2(x + 4.0, ruler.center().y - 2.0), Align2::LEFT_CENTER, timecode(t, project.fps).trim_end_matches(".00"), font::ui(11.0), color::INK_MUTED);
            }
            t += step;
        }

        // Tracks
        for (index, track) in project.tracks.iter().enumerate() {
            let r = row(index);
            painter.line_segment([pos2(rect.left(), r.bottom()), pos2(rect.right(), r.bottom())], Stroke::new(1.0, color::HAIRLINE));
            painter.text(pos2(r.left() + 10.0, r.top() + 14.0), Align2::LEFT_CENTER, &track.name, font::ui(12.0), color::INK_SOFT);
        }
        let mut toggles = Vec::new();
        for (index, track) in project.tracks.iter().enumerate() {
            let r = row(index);
            let buttons = Rect::from_min_size(pos2(r.left() + 6.0, r.top() + 22.0), vec2(HEADER - 12.0, 30.0));
            ui.scope_builder(UiBuilder::new().max_rect(buttons), |ui| {
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 2.0;
                    if icon_button(ui, Icon::Audio, if track.muted { "Unmute" } else { "Mute" }, track.muted).clicked() {
                        toggles.push((index, true));
                    }
                    if track.kind == TrackKind::Video && icon_button(ui, Icon::Video, if track.hidden { "Show" } else { "Hide" }, track.hidden).clicked() {
                        toggles.push((index, false));
                    }
                });
            });
        }
        if !toggles.is_empty() {
            history.record(project);
            for (index, mute) in toggles {
                let track = &mut project.tracks[index];
                if mute { track.muted = !track.muted } else { track.hidden = !track.hidden }
            }
            output.changed = true;
        }
        let add_row = row(project.tracks.len());
        painter.text(pos2(add_row.left() + 10.0, add_row.top() + 16.0), Align2::LEFT_CENTER, "Drop media to add a track", font::ui(11.0), color::INK_FAINT);

        // Clips
        let lane_painter = painter.with_clip_rect(Rect::from_min_max(pos2(lanes.left(), rect.top() + RULER), rect.max));
        let mut clicked_clip = false;
        let clips: Vec<(usize, crate::project::Clip)> = project.tracks.iter().enumerate().flat_map(|(i, t)| t.clips.iter().map(move |c| (i, c.clone()))).collect();
        for (track_index, clip) in clips {
            let Some(media) = project.media(&clip.media_id).cloned() else { continue };
            let r = row(track_index);
            let clip_rect = Rect::from_min_max(pos2(x_of(clip.start), r.top() + 4.0), pos2(x_of(clip.end()), r.bottom() - 4.0));
            let visible = clip_rect.intersect(lanes);
            if visible.width() <= 0.0 {
                continue;
            }
            let selected = self.selection.contains(&clip.id);
            lane_painter.rect_filled(clip_rect, 6, clip_fill(media.kind));
            // Pictures across the top of the clip's body and its sound mirrored along the bottom; a sound clip is all sound.
            let body = Rect::from_min_max(pos2(clip_rect.left() + 2.0, clip_rect.top() + 16.0), clip_rect.max - vec2(2.0, 2.0));
            let wave = looks.waveforms.get(&media.id);
            let (pictures, sound) = match (media.kind, wave.is_some()) {
                (MediaKind::Audio, _) => (None, Some(body)),
                (_, true) => {
                    let split = body.top() + body.height() * 0.62;
                    (Some(Rect::from_min_max(body.min, pos2(body.right(), split))), Some(Rect::from_min_max(pos2(body.left(), split), body.max)))
                }
                (_, false) => (Some(body), None),
            };
            if let Some(area) = pictures {
                if let Some(strip) = looks.filmstrips.get(&media.id) {
                    let width = area.height() * 16.0 / 9.0;
                    let mut x = area.left() + ((visible.left() - area.left()) / width).floor().max(0.0) * width;
                    while x < visible.right().min(area.right()) {
                        let shown = Rect::from_min_size(pos2(x, area.top()), vec2(width, area.height())).intersect(area);
                        let mut uv = strip.uv(clip.source_time(t_of(x + width / 2.0)));
                        // A tile cut off at the clip's end shows the left part of its frame.
                        uv.max.x = uv.min.x + uv.width() * shown.width() / width;
                        lane_painter.image(strip.texture.id(), shown, uv, Color32::WHITE);
                        x += width;
                    }
                } else if let Some(texture) = looks.thumbnails.get(&media.id) {
                    let thumb = Rect::from_min_size(area.min, vec2((area.height() * 16.0 / 9.0).min(area.width()), area.height()));
                    if thumb.width() > 8.0 {
                        lane_painter.image(texture.id(), thumb, Rect::from_min_max(pos2(0.0, 0.0), pos2(1.0, 1.0)), Color32::WHITE);
                    }
                }
            }
            if let (Some(area), Some(wave)) = (sound, wave) {
                let ink = color::INK.gamma_multiply(0.55);
                let (step, half) = (2.0, area.height() / 2.0 - 1.0);
                let mut x = visible.left().max(area.left());
                while x < visible.right().min(area.right()) {
                    // Square root, so quiet sound (speech sits around a tenth of full scale) still shows.
                    let loud = (wave.peak(clip.source_time(t_of(x)), clip.source_time(t_of(x + step))) as f32 / 255.0 * clip.volume).min(1.0).sqrt();
                    let h = (loud * half).max(0.5);
                    lane_painter.line_segment([pos2(x, area.center().y - h), pos2(x, area.center().y + h)], Stroke::new(1.2, ink));
                    x += step;
                }
            }
            lane_painter.with_clip_rect(visible.shrink(2.0)).text(pos2(clip_rect.left() + 6.0, clip_rect.top() + 8.0), Align2::LEFT_CENTER, &media.name, font::ui(11.0), color::INK);
            lane_painter.rect_stroke(clip_rect, 6, Stroke::new(if selected { 2.0 } else { 1.0 }, if selected { color::SELECT_INK } else { color::HAIRLINE_STRONG }), StrokeKind::Inside);

            let response = ui.interact(visible, ui.scope_id().with(("clip", &clip.id)), Sense::click_and_drag());
            let near_edge = |x: f32| (x - clip_rect.left()).abs() <= EDGE || (x - clip_rect.right()).abs() <= EDGE;
            if response.hovered() {
                ui.ctx().set_cursor_icon(if pointer.map(|p| near_edge(p.x)).unwrap_or(false) { CursorIcon::ResizeHorizontal } else { CursorIcon::Grab });
            }
            if response.clicked() {
                clicked_clip = true;
                if ui.input(|i| i.modifiers.shift) {
                    if selected { self.selection.retain(|id| id != &clip.id) } else { self.selection.push(clip.id.clone()) }
                } else {
                    self.selection = vec![clip.id.clone()];
                }
            }
            if response.drag_started() {
                if let Some(p) = response.interact_pointer_pos() {
                    history.record(project);
                    self.gesture = Some(if (p.x - clip_rect.left()).abs() <= EDGE {
                        Gesture::TrimStart(clip.id.clone())
                    } else if (p.x - clip_rect.right()).abs() <= EDGE {
                        Gesture::TrimEnd(clip.id.clone())
                    } else {
                        Gesture::Move { clip: clip.id.clone(), grab: t_of(p.x) - clip.start }
                    });
                    if !selected {
                        self.selection = vec![clip.id.clone()];
                    }
                }
            }
        }

        // An active move or trim follows the pointer until release.
        if let (Some(gesture), Some(p)) = (&self.gesture, ui.input(|i| i.pointer.interact_pos())) {
            if ui.input(|i| i.pointer.primary_down()) {
                let t = t_of(p.x);
                match gesture {
                    Gesture::Move { clip, grab } => {
                        if let Some(at) = project.find(clip) {
                            let duration = project.tracks[at.track].clips[at.index].duration;
                            let start = t - grab;
                            let snapped_start = self.snap(project, Some(clip), playhead, start);
                            let snapped_end = self.snap(project, Some(clip), playhead, start + duration) - duration;
                            let start = if (snapped_start - start).abs() <= (snapped_end - start).abs() { snapped_start } else { snapped_end };
                            let hovered = row_at(p.y);
                            let track = if hovered >= 0.0 && (hovered as usize) < project.tracks.len() && project.tracks[hovered as usize].kind == project.tracks[at.track].kind { hovered as usize } else { at.track };
                            output.changed |= project.move_clip(clip, start, track);
                        }
                    }
                    Gesture::TrimStart(clip) => output.changed |= project.trim_start(clip, self.snap(project, Some(clip), playhead, t)),
                    Gesture::TrimEnd(clip) => output.changed |= project.trim_end(clip, self.snap(project, Some(clip), playhead, t)),
                }
                ui.ctx().set_cursor_icon(if matches!(gesture, Gesture::Move { .. }) { CursorIcon::Grabbing } else { CursorIcon::ResizeHorizontal });
            } else {
                self.gesture = None;
            }
        }

        // Clicking or dragging on the ruler or an empty lane moves the playhead.
        if self.gesture.is_none() && (background.clicked() || background.dragged()) {
            if let Some(p) = background.interact_pointer_pos().filter(|p| p.x >= lanes.left()) {
                output.seek = Some(t_of(p.x).max(0.0));
                if background.clicked() && !clicked_clip && p.y > ruler.bottom() {
                    self.selection.clear();
                }
            }
        }

        // Wheel scrolls through time; Ctrl+wheel zooms around the pointer.
        if let Some(p) = pointer.filter(|p| rect.contains(*p)) {
            let (zoom, delta) = ui.input(|i| (i.zoom_delta(), i.smooth_scroll_delta()));
            if zoom != 1.0 {
                let anchor = t_of(p.x);
                self.pps = (self.pps * zoom).clamp(2.0, 600.0);
                self.scroll = (anchor - ((p.x - lanes.left()) / self.pps) as f64).max(0.0);
            } else if delta.x != 0.0 || delta.y != 0.0 {
                self.scroll = (self.scroll - ((delta.x + delta.y) / self.pps) as f64).max(0.0);
            }
        }

        // Drops from the media bin or Canopy's sidebar land at the pointer, on the row under it.
        let dragging = DragAndDrop::has_payload_of_type::<MediaDrag>(ui.ctx()) || DragAndDrop::has_payload_of_type::<DraggedFiles>(ui.ctx());
        if let Some(p) = pointer.filter(|p| dragging && lanes.contains(*p)) {
            painter.line_segment([pos2(p.x, rect.top() + RULER), pos2(p.x, rect.bottom())], Stroke::new(2.0, color::SELECT_LINE));
            if ui.input(|i| i.pointer.any_released()) {
                let at = self.snap(project, None, playhead, t_of(p.x).max(0.0));
                let hovered = row_at(p.y);
                let track = (hovered >= 0.0 && (hovered as usize) < project.tracks.len()).then_some(hovered as usize);
                // take_payload clears whatever payload there is, even one of another type: ask for the right one.
                if let Some(drag) = DragAndDrop::has_payload_of_type::<MediaDrag>(ui.ctx()).then(|| DragAndDrop::take_payload::<MediaDrag>(ui.ctx())).flatten() {
                    history.record(project);
                    if let Some(id) = project.place(&drag.0, track, at) {
                        self.selection = vec![id];
                        output.changed = true;
                    }
                } else if let Some(files) = DragAndDrop::take_payload::<DraggedFiles>(ui.ctx()) {
                    output.dropped = Some((files.0.clone(), at, track));
                }
            }
        }

        // Playhead
        let x = x_of(playhead);
        if x >= lanes.left() && x <= rect.right() {
            painter.line_segment([pos2(x, rect.top()), pos2(x, rect.bottom())], Stroke::new(1.5, color::SUN));
            painter.add(egui::Shape::convex_polygon(vec![pos2(x - 5.0, rect.top()), pos2(x + 5.0, rect.top()), pos2(x, rect.top() + 7.0)], color::SUN, Stroke::NONE));
        }
        output
    }

    /// Keeps the playhead in view while playing.
    pub fn follow(&mut self, playhead: f64, width: f32) {
        let visible = ((width - HEADER) / self.pps) as f64;
        if playhead < self.scroll || playhead > self.scroll + visible * 0.9 {
            self.scroll = (playhead - visible * 0.1).max(0.0);
        }
    }
}
