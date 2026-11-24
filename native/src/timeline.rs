//! The timeline: a ruler, one row per track, clips you can move, trim and select, and the playhead.
//! It edits the project through `Project`'s methods and reports seeks and drops back to the editor.

use crate::filmstrip::Strip;
use crate::keys::{self, Cmd};
use crate::project::{Clip, History, Landing, MediaKind, Project, TrackKind};
use crate::waveform::Waveform;
use canopy_ui::{DraggedFiles, Icon, SharedFile, color, font, icon_button};
use egui::{
    Align2, Color32, CursorIcon, DragAndDrop, Rect, Sense, Stroke, StrokeKind, TextureHandle, Ui,
    UiBuilder, pos2, vec2,
};
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
    /// Moves the selected clips together (and their partners). Each frame starts again from the project as it was
    /// when the drag began, so the clips the selection passes over move aside and come back as it goes by.
    Move {
        /// The clip under the pointer, and where in it the pointer took hold.
        clip: String,
        grab: f64,
        /// The selected clips that move, and the track the one under the pointer was on.
        ids: Vec<String>,
        track: usize,
        base: Box<Project>,
        /// The last move worked out (seconds, rows), so holding still doesn't redo it.
        last: Option<(f64, isize)>,
    },
    TrimStart {
        clip: String,
        /// How much the clip has grown past the timeline's start during this drag.
        grown: f64,
    },
    TrimEnd(String),
    /// Ctrl-drag on the cut between two touching clips: the first ends and the second starts where the pointer is.
    Roll {
        left: String,
        right: String,
    },
    /// Ctrl-drag inside a clip that touches another: it moves, playing the same footage, and the clips touching it
    /// give or take the difference.
    Slide {
        clip: String,
        grab: f64,
    },
    /// Alt-drag: the clip stays put and plays another stretch of its source (where the drag began, from `source_in`).
    Slip {
        clip: String,
        from: f64,
        source_in: f64,
    },
}

pub struct Timeline {
    /// Pixels per second.
    pub pps: f32,
    /// The time at the left edge of the lanes.
    pub scroll: f64,
    /// How far the rows are scrolled down, in pixels (Shift+wheel), when there are more than fit.
    pub vscroll: f32,
    pub selection: Vec<String>,
    pub snap: bool,
    gesture: Option<Gesture>,
    /// A title being dragged: which, by which part, its start and end then, and where the button went down.
    title_grab: Option<(String, Grab, f64, f64, f32)>,
    /// A blur being dragged on the Blurs row, the same way.
    blur_grab: Option<(String, Grab, f64, f64, f32)>,
    /// Where dragged clips are going in between others (the cut), shown as a line while the drag lasts.
    insert_line: Option<f64>,
    /// A medium from the bin held over the lanes: it's on the timeline already, where it would land, until it's let
    /// go (then it stays) or taken away (then the project goes back to how it was).
    drop_preview: Option<DropPreview>,
    /// A box being dragged out over the lanes to pick everything it touches, as on the desktop.
    marquee: Option<Marquee>,
    /// The time where a clip was last right-clicked, for its menu.
    menu_at: f64,
}

struct Marquee {
    /// Where the drag began: a time and a height among the rows (so the box stays put while the timeline scrolls).
    from: (f64, f32),
    /// What was picked before, kept when Shift or Ctrl was held as the drag began.
    keep: Vec<String>,
}

struct DropPreview {
    base: Box<Project>,
    /// What it was last worked out for (media, time, row), the clip it made and the cut it went in at.
    last: (String, f64, Option<usize>),
    clip: Option<String>,
    insert_at: Option<f64>,
}

/// How long clips take to slide out of the way of a drag, in seconds.
const SLIDE: f32 = 0.12;

#[derive(Clone, Copy, PartialEq)]
enum Grab {
    Move,
    Start,
    End,
}

impl Default for Timeline {
    fn default() -> Self {
        Self {
            pps: 60.0,
            scroll: 0.0,
            vscroll: 0.0,
            selection: Vec::new(),
            snap: true,
            gesture: None,
            title_grab: None,
            blur_grab: None,
            insert_line: None,
            drop_preview: None,
            marquee: None,
            menu_at: 0.0,
        }
    }
}

#[derive(Default)]
pub struct Output {
    pub seek: Option<f64>,
    /// Files dropped from Canopy's sidebar: import them, then place them here.
    pub dropped: Option<(Vec<SharedFile>, f64, Option<usize>)>,
    pub changed: bool,
    /// What was chosen in a clip's right-click menu.
    pub menu: Option<MenuChoice>,
}

/// A command chosen in a clip's right-click menu: the clip, and the time where it was right-clicked.
pub struct MenuChoice {
    pub cmd: Cmd,
    pub clip: String,
    pub at: f64,
}

/// What a right-clicked clip is, for which of its menu's entries make sense.
struct MenuFacts<'a> {
    clip: &'a Clip,
    /// Audio for any clip on an audio track (a video's detached sound included).
    kind: MediaKind,
    has_sound: bool,
    /// How many clips are picked (the right-clicked one among them).
    picked: usize,
    playhead: f64,
    at: f64,
    fps: u32,
    /// A still PNG, JPEG or WebP Folio can edit.
    editable: bool,
    /// From the start of the first picked thing to the end of the last.
    span: (f64, f64),
}

/// A clip's right-click menu: the usual edits, then what this clip can do. Each entry shows its key.
fn clip_menu(ui: &mut Ui, facts: &MenuFacts) -> Option<Cmd> {
    ui.set_min_width(250.0);
    let mut chosen = None;
    let mut item = |ui: &mut Ui, cmd: Cmd, label: &str| {
        let keys = keys::COMMANDS
            .iter()
            .find(|c| c.cmd == cmd)
            .and_then(|c| c.keys.first())
            .map(keys::Shortcut::label)
            .unwrap_or_default();
        if ui.add(egui::Button::new(label).shortcut_text(keys)).clicked() {
            chosen = Some(cmd);
        }
    };
    let clip = facts.clip;
    let one = facts.picked <= 1;
    let (from, to) = facts.span;
    item(ui, Cmd::ExportPart, &format!("Export {} to {} as a video", timecode(from, facts.fps), timecode(to, facts.fps)));
    item(ui, Cmd::BlurPart, &format!("Blur {} to {}", timecode(from, facts.fps), timecode(to, facts.fps)));
    ui.separator();
    let video = facts.kind == MediaKind::Video;
    if one && facts.kind == MediaKind::Image && facts.editable {
        item(ui, Cmd::EditInFolio, "Edit the picture in Folio");
        ui.separator();
    }
    if one && video {
        // The frame under the playhead when it's on this clip, else the one where it was right-clicked.
        let t = if clip.contains(facts.playhead) { facts.playhead } else { facts.at };
        item(ui, Cmd::GrabFrame, &format!("Grab the frame at {} as a picture", timecode(t, facts.fps)));
        item(ui, Cmd::EditFrameInFolio, &format!("Edit the frame at {} in Folio", timecode(t, facts.fps)));
        ui.separator();
    }
    if clip.contains(facts.playhead) && clip.start < facts.playhead {
        item(ui, Cmd::Split, "Split at the playhead");
    }
    item(ui, Cmd::Copy, "Copy");
    item(ui, Cmd::CutClips, "Cut");
    item(ui, Cmd::Duplicate, "Duplicate");
    item(ui, Cmd::Delete, "Delete");
    item(ui, Cmd::RippleDelete, "Delete and close the gap");
    ui.separator();
    if facts.kind != MediaKind::Image {
        item(ui, Cmd::ChangeSpeed, "Change speed…");
    }
    if clip.fade_in > 0.0 || clip.fade_out > 0.0 {
        item(ui, Cmd::NoFades, "No fades");
    } else {
        item(ui, Cmd::Fades, "Fade in and out");
    }
    if facts.kind != MediaKind::Audio {
        item(ui, Cmd::FitOrFill, "Fit or fill the frame");
        if !clip.place.is_full() {
            item(ui, Cmd::ResetPlace, "Reset size, place and crop");
        }
    }
    if one {
        if video && facts.has_sound && clip.link.is_none() {
            item(ui, Cmd::DetachSound, "Detach sound");
        }
        if clip.link.is_some() {
            item(ui, Cmd::Unlink, "Unlink");
        }
        if clip.group.is_some() {
            item(ui, Cmd::Ungroup, "Ungroup");
        }
        if video {
            item(ui, Cmd::DetectScenes, "Detect scenes");
        }
        ui.separator();
        item(ui, Cmd::ClipMenu, "More in the Clip menu…");
    }
    chosen
}

/// From the start of the first picked clip, title or caption to the end of the last.
pub fn picked_span(project: &Project, selection: &[String]) -> Option<(f64, f64)> {
    let spans = selection.iter().filter_map(|id| {
        project
            .clip(id)
            .map(|c| (c.start, c.end()))
            .or_else(|| project.titles.iter().find(|t| &t.id == id).map(|t| (t.start, t.end)))
            .or_else(|| project.captions.iter().find(|c| &c.id == id).map(|c| (c.start, c.end)))
            .or_else(|| project.blurs.iter().find(|b| &b.id == id).map(|b| (b.start, b.end)))
    });
    spans.fold(None, |span: Option<(f64, f64)>, (s, e)| Some(span.map_or((s, e), |(a, b)| (a.min(s), b.max(e)))))
}

fn tick_step(pps: f32) -> f64 {
    [
        0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0, 15.0, 30.0, 60.0, 120.0, 300.0, 600.0, 1800.0,
    ]
    .into_iter()
    .find(|s| s * pps as f64 >= 70.0)
    .unwrap_or(3600.0)
}

pub fn timecode(seconds: f64, fps: u32) -> String {
    let total = seconds.max(0.0);
    let s = total.floor() as u64;
    let frames = ((total - s as f64) * fps as f64).floor() as u64;
    if s >= 3600 {
        format!(
            "{}:{:02}:{:02}.{:02}",
            s / 3600,
            s / 60 % 60,
            s % 60,
            frames
        )
    } else {
        format!("{:02}:{:02}.{:02}", s / 60, s % 60, frames)
    }
}

const CAPTION_FILL: Color32 = Color32::from_rgb(0x3A, 0x3F, 0x52);
const TITLE_FILL: Color32 = Color32::from_rgb(0x52, 0x46, 0x2E);
const BLUR_FILL: Color32 = Color32::from_rgb(0x2E, 0x4A, 0x52);

/// Which part of a block on a text or blur row is under `x`: an edge within reach (the nearer one), else the middle.
/// A block too short to have a middle beside its edges keeps its middle third for moving.
fn grab_part(x: f32, block: Rect) -> Grab {
    let reach = EDGE.min(block.width() / 3.0);
    let (left, right) = ((x - block.left()).abs(), (x - block.right()).abs());
    if left <= reach && left <= right {
        Grab::Start
    } else if right <= reach {
        Grab::End
    } else {
        Grab::Move
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
    fn snap(&self, project: &Project, ignore: &[&str], playhead: f64, t: f64) -> f64 {
        if !self.snap {
            return t;
        }
        let reach = (SNAP_PX / self.pps) as f64;
        let mut points = project.snap_points(ignore);
        points.push(playhead);
        points
            .into_iter()
            .filter(|p| (p - t).abs() <= reach)
            .min_by(|a, b| (a - t).abs().total_cmp(&(b - t).abs()))
            .unwrap_or(t)
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
        // Rows, top to bottom: the tracks, the one to drop media on, the text tracks (titles that overlap in time go
        // on separate ones), captions, then blurs. When they don't all fit, Shift+wheel scrolls them.
        let title_rows = project.title_rows();
        let text_tracks = title_rows.iter().max().map_or(0, |r| r + 1);
        let first_text = project.tracks.len() + 1;
        let first_blur = first_text + text_tracks + usize::from(!project.captions.is_empty());
        let lane_count = first_blur + usize::from(!project.blurs.is_empty());
        let overflow = (RULER + lane_count as f32 * ROW - rect.height()).max(0.0);
        self.vscroll = self.vscroll.clamp(0.0, overflow);
        let (pps, scroll, vscroll) = (self.pps, self.scroll, self.vscroll);
        let x_of = |t: f64| lanes.left() + ((t - scroll) as f32) * pps;
        let t_of = |x: f32| scroll + ((x - lanes.left()) / pps) as f64;
        let row = |i: usize| {
            Rect::from_min_size(
                pos2(rect.left(), rect.top() + RULER + i as f32 * ROW - vscroll),
                vec2(rect.width(), ROW),
            )
        };
        let pointer = ui.input(|i| i.pointer.hover_pos());
        let row_at = |y: f32| ((y - rect.top() - RULER + vscroll) / ROW).floor();
        // Everything under the ruler: rows scrolled up out of it are cut off there.
        let body = Rect::from_min_max(pos2(rect.left(), rect.top() + RULER), rect.max);
        let body_painter = painter.with_clip_rect(body);
        let lane_area = Rect::from_min_max(pos2(lanes.left(), body.top()), rect.max);

        // Ruler
        let ruler = Rect::from_min_max(
            pos2(lanes.left(), rect.top()),
            pos2(rect.right(), rect.top() + RULER),
        );
        painter.rect_filled(ruler, 0, color::VEIL);
        let step = tick_step(pps);
        let mut t = (scroll / step).floor() * step;
        while x_of(t) < rect.right() {
            let x = x_of(t);
            if x >= lanes.left() {
                painter.line_segment(
                    [pos2(x, ruler.bottom() - 7.0), pos2(x, ruler.bottom())],
                    Stroke::new(1.0, color::INK_FAINT),
                );
                painter.text(
                    pos2(x + 4.0, ruler.center().y - 2.0),
                    Align2::LEFT_CENTER,
                    timecode(t, project.fps).trim_end_matches(".00"),
                    font::ui(11.0),
                    color::INK_MUTED,
                );
            }
            t += step;
        }
        // Markers: a small flag on the ruler and a faint line down the lanes; click one to go there, right-click to remove it.
        let mut remove_marker = None;
        for marker in &project.markers {
            let x = x_of(marker.t);
            if x < lanes.left() || x > rect.right() {
                continue;
            }
            painter.line_segment(
                [pos2(x, ruler.bottom()), pos2(x, rect.bottom())],
                Stroke::new(1.0, color::SUN.gamma_multiply(0.35)),
            );
            painter.add(egui::Shape::convex_polygon(
                vec![
                    pos2(x - 5.0, ruler.top() + 3.0),
                    pos2(x + 5.0, ruler.top() + 3.0),
                    pos2(x + 5.0, ruler.top() + 10.0),
                    pos2(x, ruler.top() + 14.0),
                    pos2(x - 5.0, ruler.top() + 10.0),
                ],
                color::SUN,
                Stroke::NONE,
            ));
            let hit = ui.interact(
                Rect::from_center_size(pos2(x, ruler.top() + 8.0), vec2(12.0, 14.0)),
                ui.scope_id().with(("marker", &marker.id)),
                Sense::click(),
            );
            let hit = if marker.label.is_empty() {
                hit
            } else {
                hit.on_hover_text(&marker.label)
            };
            if hit.clicked() {
                output.seek = Some(marker.t);
            }
            if hit.secondary_clicked() {
                remove_marker = Some(marker.id.clone());
            }
        }
        if let Some(id) = remove_marker {
            history.record(project);
            project.markers.retain(|m| m.id != id);
            output.changed = true;
        }

        // Tracks
        for (index, track) in project.tracks.iter().enumerate() {
            let r = row(index);
            body_painter.line_segment(
                [
                    pos2(rect.left(), r.bottom()),
                    pos2(rect.right(), r.bottom()),
                ],
                Stroke::new(1.0, color::HAIRLINE),
            );
            body_painter.text(
                pos2(r.left() + 10.0, r.top() + 14.0),
                Align2::LEFT_CENTER,
                &track.name,
                font::ui(12.0),
                color::INK_SOFT,
            );
        }
        let mut toggles = Vec::new();
        let mut locks = Vec::new();
        for (index, track) in project.tracks.iter().enumerate() {
            let r = row(index);
            let buttons = Rect::from_min_size(
                pos2(r.left() + 6.0, r.top() + 22.0),
                vec2(HEADER - 12.0, 30.0),
            );
            if !buttons.intersects(body) {
                continue;
            }
            ui.scope_builder(UiBuilder::new().max_rect(buttons), |ui| {
                ui.set_clip_rect(ui.clip_rect().intersect(body));
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 2.0;
                    if icon_button(
                        ui,
                        Icon::Audio,
                        if track.muted { "Unmute" } else { "Mute" },
                        track.muted,
                    )
                    .clicked()
                    {
                        toggles.push((index, true));
                    }
                    if track.kind == TrackKind::Video
                        && icon_button(
                            ui,
                            Icon::Video,
                            if track.hidden { "Show" } else { "Hide" },
                            track.hidden,
                        )
                        .clicked()
                    {
                        toggles.push((index, false));
                    }
                    if icon_button(
                        ui,
                        Icon::Lock,
                        if track.locked {
                            "Unlock"
                        } else {
                            "Lock: keep its clips as they are"
                        },
                        track.locked,
                    )
                    .clicked()
                    {
                        locks.push(index);
                    }
                });
            });
        }
        if !locks.is_empty() {
            history.record(project);
            for index in locks {
                let track = &mut project.tracks[index];
                track.locked = !track.locked;
                // What's selected on a track that locks is let go.
                if track.locked {
                    let ids: Vec<String> = track.clips.iter().map(|c| c.id.clone()).collect();
                    self.selection.retain(|id| !ids.contains(id));
                }
            }
            output.changed = true;
        }
        if !toggles.is_empty() {
            history.record(project);
            for (index, mute) in toggles {
                let track = &mut project.tracks[index];
                if mute {
                    track.muted = !track.muted
                } else {
                    track.hidden = !track.hidden
                }
            }
            output.changed = true;
        }
        let add_row = row(project.tracks.len());
        body_painter.text(
            pos2(add_row.left() + 10.0, add_row.top() + 16.0),
            Align2::LEFT_CENTER,
            "Drop media to add a track",
            font::ui(11.0),
            color::INK_FAINT,
        );

        // Clips
        let lane_painter = painter.with_clip_rect(lane_area);
        let mut clicked_clip = false;
        // Where each clip, title and caption is (not locked clips), for picking them with a box: in time, so ones
        // scrolled out of sight while the box is out stay in it, and in height among the rows (on the screen, plus
        // how far the rows are scrolled).
        let mut boxes: Vec<(String, f64, f64, f32, f32)> = Vec::new();
        let clips: Vec<(usize, crate::project::Clip)> = project
            .tracks
            .iter()
            .enumerate()
            .flat_map(|(i, t)| t.clips.iter().map(move |c| (i, c.clone())))
            .collect();
        // While clips are dragged (or media is held over the lanes), the others slide to their new places instead of
        // jumping; the dragged ones follow the pointer exactly.
        let moving: Vec<String> = match (&self.gesture, &self.drop_preview) {
            (Some(Gesture::Move { ids, .. }), _) => project.with_linked(ids),
            (_, Some(preview)) => preview.clip.iter().cloned().collect(),
            _ => Vec::new(),
        };
        let sliding = matches!(self.gesture, Some(Gesture::Move { .. })) || self.drop_preview.is_some();
        for (track_index, mut clip) in clips {
            let Some(media) = project.media(&clip.media_id).cloned() else {
                continue;
            };
            let real_start = clip.start;
            let shown = ui.ctx().animate_value_with_time(
                ui.scope_id().with(("slide", &clip.id)),
                clip.start as f32,
                if sliding && !moving.contains(&clip.id) { SLIDE } else { 0.0 },
            );
            if shown != clip.start as f32 {
                clip.start = shown as f64;
            }
            let r = row(track_index);
            if !project.tracks[track_index].locked {
                boxes.push((
                    clip.id.clone(),
                    real_start,
                    real_start + clip.duration,
                    r.top() + 4.0 + vscroll,
                    r.bottom() - 4.0 + vscroll,
                ));
            }
            let clip_rect = Rect::from_min_max(
                pos2(x_of(clip.start), r.top() + 4.0),
                pos2(x_of(clip.end()), r.bottom() - 4.0),
            );
            let visible = clip_rect.intersect(lane_area);
            if visible.width() <= 0.0 || visible.height() <= 0.0 {
                continue;
            }
            let selected = self.selection.contains(&clip.id);
            // A clip on an audio track is all sound, whatever its media (a video's detached sound).
            let kind = if project.tracks[track_index].kind == TrackKind::Audio {
                MediaKind::Audio
            } else {
                media.kind
            };
            lane_painter.rect_filled(clip_rect, 6, clip_fill(kind));
            // Pictures across the top of the clip's body and its sound mirrored along the bottom; a sound clip is all sound.
            let body = Rect::from_min_max(
                pos2(clip_rect.left() + 2.0, clip_rect.top() + 16.0),
                clip_rect.max - vec2(2.0, 2.0),
            );
            // A video clip whose sound was detached shows no sound of its own.
            let wave = looks
                .waveforms
                .get(&media.id)
                .filter(|_| !project.sounds_elsewhere(&clip));
            let (pictures, sound) = match (kind, wave.is_some()) {
                (MediaKind::Audio, _) => (None, Some(body)),
                (_, true) => {
                    let split = body.top() + body.height() * 0.62;
                    (
                        Some(Rect::from_min_max(body.min, pos2(body.right(), split))),
                        Some(Rect::from_min_max(pos2(body.left(), split), body.max)),
                    )
                }
                (_, false) => (Some(body), None),
            };
            if let Some(area) = pictures {
                if let Some(strip) = looks.filmstrips.get(&media.id) {
                    let width = area.height() * 16.0 / 9.0;
                    let mut x = area.left()
                        + ((visible.left() - area.left()) / width).floor().max(0.0) * width;
                    while x < visible.right().min(area.right()) {
                        let shown =
                            Rect::from_min_size(pos2(x, area.top()), vec2(width, area.height()))
                                .intersect(area);
                        let mut uv = strip.uv(clip.source_time(t_of(x + width / 2.0)));
                        // A tile cut off at the clip's end shows the left part of its frame.
                        uv.max.x = uv.min.x + uv.width() * shown.width() / width;
                        lane_painter.image(strip.texture.id(), shown, uv, Color32::WHITE);
                        x += width;
                    }
                } else if let Some(texture) = looks.thumbnails.get(&media.id) {
                    let thumb = Rect::from_min_size(
                        area.min,
                        vec2(
                            (area.height() * 16.0 / 9.0).min(area.width()),
                            area.height(),
                        ),
                    );
                    if thumb.width() > 8.0 {
                        lane_painter.image(
                            texture.id(),
                            thumb,
                            Rect::from_min_max(pos2(0.0, 0.0), pos2(1.0, 1.0)),
                            Color32::WHITE,
                        );
                    }
                }
            }
            if let (Some(area), Some(wave)) = (sound, wave) {
                let ink = color::INK.gamma_multiply(0.55);
                let (step, half) = (2.0, area.height() / 2.0 - 1.0);
                let mut x = visible.left().max(area.left());
                while x < visible.right().min(area.right()) {
                    // Square root, so quiet sound (speech sits around a tenth of full scale) still shows.
                    let loud = (wave
                        .peak(clip.source_time(t_of(x)), clip.source_time(t_of(x + step)))
                        as f32
                        / 255.0
                        * clip.volume)
                        .min(1.0)
                        .sqrt();
                    let h = (loud * half).max(0.5);
                    lane_painter.line_segment(
                        [pos2(x, area.center().y - h), pos2(x, area.center().y + h)],
                        Stroke::new(1.2, ink),
                    );
                    x += step;
                }
            }
            let name = if clip.group.is_some() {
                format!("{} · grouped", media.name)
            } else if clip.link.is_some() {
                format!("{} · linked", media.name)
            } else {
                media.name.clone()
            };
            lane_painter.with_clip_rect(visible.shrink(2.0)).text(
                pos2(clip_rect.left() + 6.0, clip_rect.top() + 8.0),
                Align2::LEFT_CENTER,
                name,
                font::ui(11.0),
                color::INK,
            );
            // A clip linked or grouped with a selected one is outlined lightly: it goes wherever the selected one does.
            let partner_selected = (clip.link.is_some() || clip.group.is_some())
                && !selected
                && project
                    .partners(&clip.id)
                    .iter()
                    .any(|id| self.selection.contains(id));
            let stroke = if selected {
                Stroke::new(2.0, color::SELECT_INK)
            } else if partner_selected {
                Stroke::new(1.5, color::SELECT_INK.gamma_multiply(0.5))
            } else {
                Stroke::new(1.0, color::HAIRLINE_STRONG)
            };
            lane_painter.rect_stroke(clip_rect, 6, stroke, StrokeKind::Inside);

            // A locked track's clips are shown dimmed and take no clicks or drags.
            let locked = project.tracks[track_index].locked;
            if locked {
                lane_painter.rect_filled(clip_rect, 6, color::VEIL_STRONG);
            }
            let response = ui.interact(
                visible,
                ui.scope_id().with(("clip", &clip.id)),
                if locked {
                    Sense::hover()
                } else {
                    Sense::click_and_drag()
                },
            );
            let near_edge = |x: f32| {
                (x - clip_rect.left()).abs() <= EDGE || (x - clip_rect.right()).abs() <= EDGE
            };
            if response.hovered() {
                ui.ctx().set_cursor_icon(if locked {
                    CursorIcon::NotAllowed
                } else if pointer.map(|p| near_edge(p.x)).unwrap_or(false) {
                    CursorIcon::ResizeHorizontal
                } else {
                    CursorIcon::Grab
                });
            }
            if response.clicked() {
                clicked_clip = true;
                if ui.input(|i| i.modifiers.shift) {
                    if selected {
                        self.selection.retain(|id| id != &clip.id)
                    } else {
                        self.selection.push(clip.id.clone())
                    }
                } else {
                    self.selection = vec![clip.id.clone()];
                }
            }
            // A right-click picks the clip (or keeps the picked ones, when it's one of them) and opens its menu.
            if response.secondary_clicked() {
                clicked_clip = true;
                if !selected {
                    self.selection = vec![clip.id.clone()];
                }
                if let Some(p) = response.interact_pointer_pos() {
                    self.menu_at = t_of(p.x).clamp(real_start, real_start + clip.duration - 1e-3);
                }
            }
            let facts = MenuFacts {
                clip: &clip,
                kind,
                has_sound: media.has_audio && kind != MediaKind::Image,
                picked: self.selection.len(),
                playhead,
                at: self.menu_at,
                fps: project.fps,
                editable: crate::app::folio_can_edit(&media),
                span: picked_span(project, &self.selection).unwrap_or((clip.start, clip.end())),
            };
            let menu_at = self.menu_at;
            if let Some(Some(cmd)) = egui::Popup::context_menu(&response)
                .close_behavior(egui::PopupCloseBehavior::CloseOnClickOutside)
                .show(|ui| {
                    let chosen = clip_menu(ui, &facts);
                    if chosen.is_some() {
                        ui.close();
                    }
                    chosen
                })
                .map(|shown| shown.inner)
            {
                output.menu = Some(MenuChoice { cmd, clip: clip.id.clone(), at: menu_at });
            }
            if response.drag_started() {
                // Where the button went down: a quick drag has already left a clip's edge when the drag begins.
                if let Some(p) = ui
                    .input(|i| i.pointer.press_origin())
                    .or(response.interact_pointer_pos())
                {
                    history.record(project);
                    let (alt, ctrl) = ui.input(|i| (i.modifiers.alt, i.modifiers.command));
                    // Ctrl on an edge that touches another clip rolls the cut between them; Ctrl inside slides.
                    let (at_start, at_end) = (
                        (p.x - clip_rect.left()).abs() <= EDGE,
                        (p.x - clip_rect.right()).abs() <= EDGE,
                    );
                    // Linked clips don't roll or slide: their partner's neighbors would fall out of step.
                    let alone = clip.link.is_none() && clip.group.is_none();
                    let (left, right) = (
                        project.left_neighbor(&clip.id).filter(|_| alone),
                        project.right_neighbor(&clip.id).filter(|_| alone),
                    );
                    self.gesture = Some(
                        if let (true, true, Some(left)) = (ctrl, at_start, left.clone()) {
                            Gesture::Roll {
                                left,
                                right: clip.id.clone(),
                            }
                        } else if let (true, true, Some(right)) = (ctrl, at_end, right.clone()) {
                            Gesture::Roll {
                                left: clip.id.clone(),
                                right,
                            }
                        } else if alt {
                            Gesture::Slip {
                                clip: clip.id.clone(),
                                from: t_of(p.x),
                                source_in: clip.source_in,
                            }
                        } else if ctrl
                            && !at_start
                            && !at_end
                            && (left.is_some() || right.is_some())
                        {
                            Gesture::Slide {
                                clip: clip.id.clone(),
                                grab: t_of(p.x) - real_start,
                            }
                        } else if (p.x - clip_rect.left()).abs() <= EDGE {
                            Gesture::TrimStart {
                                clip: clip.id.clone(),
                                grown: 0.0,
                            }
                        } else if (p.x - clip_rect.right()).abs() <= EDGE {
                            Gesture::TrimEnd(clip.id.clone())
                        } else {
                            // Dragging a selected clip takes all the selected clips along; any other clip goes alone.
                            if !selected {
                                self.selection = vec![clip.id.clone()];
                            }
                            let ids = self
                                .selection
                                .iter()
                                .filter(|id| project.find(id).is_some())
                                .cloned()
                                .collect();
                            Gesture::Move {
                                clip: clip.id.clone(),
                                grab: t_of(p.x) - real_start,
                                ids,
                                track: track_index,
                                base: Box::new(project.clone()),
                                last: None,
                            }
                        },
                    );
                    if !selected {
                        self.selection = vec![clip.id.clone()];
                    }
                }
            }
        }

        // Text tracks under the tracks: titles (click to select, drag to move in time or onto another text track), then
        // captions (click to select).
        for k in 0..text_tracks {
            let lane = row(first_text + k);
            body_painter.line_segment(
                [pos2(rect.left(), lane.bottom()), pos2(rect.right(), lane.bottom())],
                Stroke::new(1.0, color::HAIRLINE),
            );
            body_painter.text(
                pos2(lane.left() + 10.0, lane.top() + 14.0),
                Align2::LEFT_CENTER,
                if k == 0 { "Titles".to_string() } else { format!("Titles {}", k + 1) },
                font::ui(12.0),
                color::INK_SOFT,
            );
        }
        if !project.titles.is_empty() {
            let (mut grabbed, mut moved, mut dropped) = (false, None, false);
            let mut to_row = None;
            for (title, &title_row) in project.titles.iter().zip(&title_rows) {
                let lane = row(first_text + title_row);
                boxes.push((
                    title.id.clone(),
                    title.start,
                    title.end,
                    lane.top() + 6.0 + vscroll,
                    lane.top() + 34.0 + vscroll,
                ));
                let block = Rect::from_min_max(
                    pos2(x_of(title.start), lane.top() + 6.0),
                    pos2(
                        x_of(title.end).max(x_of(title.start) + 3.0),
                        lane.top() + 34.0,
                    ),
                );
                let visible = block.intersect(lane_area);
                if visible.width() <= 0.0 || visible.height() <= 0.0 {
                    continue;
                }
                let selected = self.selection.contains(&title.id);
                lane_painter.rect_filled(block, 5, TITLE_FILL);
                lane_painter.rect_stroke(
                    block,
                    5,
                    Stroke::new(
                        if selected { 2.0 } else { 1.0 },
                        if selected {
                            color::SELECT_INK
                        } else {
                            color::HAIRLINE_STRONG
                        },
                    ),
                    StrokeKind::Inside,
                );
                lane_painter.with_clip_rect(visible.shrink(3.0)).text(
                    pos2(block.left() + 6.0, block.center().y),
                    Align2::LEFT_CENTER,
                    &title.text,
                    font::ui(11.0),
                    color::INK,
                );
                // A little wider than it's drawn, so an edge can be taken from just outside it too.
                let response = ui.interact(
                    visible.expand2(vec2(EDGE, 0.0)).intersect(lane_area),
                    ui.scope_id().with(("title", &title.id)),
                    Sense::click_and_drag(),
                );
                // Which part is under x: an edge within reach (the nearer one), else the middle. A title too short to
                // have a middle beside its edges keeps its middle third for moving.
                let reach = EDGE.min(block.width() / 3.0);
                let part = |x: f32| {
                    let (left, right) = ((x - block.left()).abs(), (x - block.right()).abs());
                    if left <= reach && left <= right {
                        Grab::Start
                    } else if right <= reach {
                        Grab::End
                    } else {
                        Grab::Move
                    }
                };
                let near_edge = |x: f32| part(x) != Grab::Move;
                if response.hovered() {
                    ui.ctx()
                        .set_cursor_icon(if pointer.is_some_and(|p| near_edge(p.x)) {
                            CursorIcon::ResizeHorizontal
                        } else {
                            CursorIcon::Grab
                        });
                }
                if response.clicked() {
                    clicked_clip = true;
                    if ui.input(|i| i.modifiers.shift) {
                        if selected {
                            self.selection.retain(|id| id != &title.id)
                        } else {
                            self.selection.push(title.id.clone())
                        }
                    } else {
                        self.selection = vec![title.id.clone()];
                    }
                }
                if response.drag_started() {
                    grabbed = true;
                    if !selected {
                        self.selection = vec![title.id.clone()];
                    }
                    // Its edges change when it starts or ends; anywhere else moves it. Decided by where the button
                    // went down: by the time egui calls it a drag, the pointer has already left a 7 px edge.
                    let down = ui.input(|i| i.pointer.press_origin()).or(response.interact_pointer_pos());
                    let grab = down.map_or(Grab::Move, |p| part(p.x));
                    let x = down.map_or(block.center().x, |p| p.x);
                    self.title_grab = Some((title.id.clone(), grab, title.start, title.end, x));
                }
                if response.dragged() {
                    if let (Some((id, grab, start, end, x)), Some(p)) = (&self.title_grab, response.interact_pointer_pos()) {
                        if id == &title.id {
                            moved = Some((title.id.clone(), *grab, *start, *end, ((p.x - x) / pps) as f64));
                        }
                    }
                }
                // Held by its middle over another text track (or the row under the last one, for a new track), it goes
                // there.
                let by_middle = matches!(&self.title_grab, Some((id, Grab::Move, ..)) if id == &title.id);
                if response.dragged() && by_middle {
                    if let Some(p) = response.interact_pointer_pos() {
                        let over = row_at(p.y) - first_text as f32;
                        if over >= 0.0 {
                            let over = (over as usize).min(text_tracks);
                            if over != title_row {
                                to_row = Some((title.id.clone(), over));
                            }
                        }
                    }
                }
                if response.drag_stopped() {
                    self.title_grab = None;
                    dropped = true;
                }
            }
            if grabbed {
                history.record(project);
                // Rows as shown, so a title dragged onto another track lands where it's pointed at.
                project.settle_title_rows();
            }
            if let Some((id, row)) = to_row {
                if let Some(title) = project.title_mut(&id) {
                    title.row = row;
                    output.changed = true;
                }
            }
            // Measured from where the drag began, so nothing is lost to the drag threshold or rounding.
            if let Some((id, grab, start, end, dt)) = moved {
                if let Some(title) = project.title_mut(&id) {
                    const SHORTEST: f64 = 0.3;
                    match grab {
                        Grab::Move => {
                            let dt = dt.max(-start);
                            (title.start, title.end) = (start + dt, end + dt);
                        }
                        Grab::Start => title.start = (start + dt).clamp(0.0, end - SHORTEST),
                        Grab::End => title.end = (end + dt).max(start + SHORTEST),
                    }
                    output.changed = true;
                }
            }
            // Let go on top of another title, it moves to the first text track free for its time.
            if dropped {
                project.settle_title_rows();
                output.changed = true;
            }
        }
        if !project.captions.is_empty() {
            let lane = row(first_text + text_tracks);
            body_painter.text(
                pos2(lane.left() + 10.0, lane.top() + 14.0),
                Align2::LEFT_CENTER,
                "Captions",
                font::ui(12.0),
                color::INK_SOFT,
            );
            for caption in &project.captions {
                boxes.push((
                    caption.id.clone(),
                    caption.start,
                    caption.end,
                    lane.top() + 6.0 + vscroll,
                    lane.top() + 34.0 + vscroll,
                ));
                let block = Rect::from_min_max(
                    pos2(x_of(caption.start), lane.top() + 6.0),
                    pos2(
                        x_of(caption.end).max(x_of(caption.start) + 3.0),
                        lane.top() + 34.0,
                    ),
                );
                let visible = block.intersect(lane_area);
                if visible.width() <= 0.0 || visible.height() <= 0.0 {
                    continue;
                }
                let selected = self.selection.contains(&caption.id);
                lane_painter.rect_filled(block, 5, CAPTION_FILL);
                lane_painter.rect_stroke(
                    block,
                    5,
                    Stroke::new(
                        if selected { 2.0 } else { 1.0 },
                        if selected {
                            color::SELECT_INK
                        } else {
                            color::HAIRLINE_STRONG
                        },
                    ),
                    StrokeKind::Inside,
                );
                lane_painter.with_clip_rect(visible.shrink(3.0)).text(
                    pos2(block.left() + 6.0, block.center().y),
                    Align2::LEFT_CENTER,
                    &caption.text,
                    font::ui(11.0),
                    color::INK,
                );
                let response = ui
                    .interact(
                        visible,
                        ui.scope_id().with(("caption", &caption.id)),
                        Sense::click(),
                    )
                    .on_hover_text(&caption.text);
                if response.clicked() {
                    clicked_clip = true;
                    if ui.input(|i| i.modifiers.shift) {
                        if selected {
                            self.selection.retain(|id| id != &caption.id)
                        } else {
                            self.selection.push(caption.id.clone())
                        }
                    } else {
                        self.selection = vec![caption.id.clone()];
                    }
                }
            }
        }

        // Blurs: a row of their own; click to pick, drag the middle to move in time, an edge to start or end it.
        if !project.blurs.is_empty() {
            let lane = row(first_blur);
            body_painter.line_segment(
                [pos2(rect.left(), lane.top()), pos2(rect.right(), lane.top())],
                Stroke::new(1.0, color::HAIRLINE),
            );
            body_painter.text(pos2(lane.left() + 10.0, lane.top() + 14.0), Align2::LEFT_CENTER, "Blurs", font::ui(12.0), color::INK_SOFT);
            let (mut grabbed, mut moved, mut dropped) = (false, None, false);
            for blur in &project.blurs {
                boxes.push((blur.id.clone(), blur.start, blur.end, lane.top() + 6.0 + vscroll, lane.top() + 34.0 + vscroll));
                let block = Rect::from_min_max(
                    pos2(x_of(blur.start), lane.top() + 6.0),
                    pos2(x_of(blur.end).max(x_of(blur.start) + 3.0), lane.top() + 34.0),
                );
                let visible = block.intersect(lane_area);
                if visible.width() <= 0.0 || visible.height() <= 0.0 {
                    continue;
                }
                let selected = self.selection.contains(&blur.id);
                lane_painter.rect_filled(block, 5, BLUR_FILL);
                lane_painter.rect_stroke(
                    block,
                    5,
                    Stroke::new(if selected { 2.0 } else { 1.0 }, if selected { color::SELECT_INK } else { color::HAIRLINE_STRONG }),
                    StrokeKind::Inside,
                );
                let whole = blur.w >= 0.999 && blur.h >= 0.999;
                lane_painter.with_clip_rect(visible.shrink(3.0)).text(
                    pos2(block.left() + 6.0, block.center().y),
                    Align2::LEFT_CENTER,
                    if whole { "Blur: whole picture" } else { "Blur" },
                    font::ui(11.0),
                    color::INK,
                );
                let response = ui.interact(
                    visible.expand2(vec2(EDGE, 0.0)).intersect(lane_area),
                    ui.scope_id().with(("blur", &blur.id)),
                    Sense::click_and_drag(),
                );
                if response.hovered() {
                    ui.ctx().set_cursor_icon(match pointer.map(|p| grab_part(p.x, block)) {
                        Some(Grab::Start | Grab::End) => CursorIcon::ResizeHorizontal,
                        _ => CursorIcon::Grab,
                    });
                }
                if response.clicked() {
                    clicked_clip = true;
                    if ui.input(|i| i.modifiers.shift) {
                        if selected {
                            self.selection.retain(|id| id != &blur.id)
                        } else {
                            self.selection.push(blur.id.clone())
                        }
                    } else {
                        self.selection = vec![blur.id.clone()];
                    }
                }
                if response.drag_started() {
                    grabbed = true;
                    if !selected {
                        self.selection = vec![blur.id.clone()];
                    }
                    // By where the button went down, as for titles.
                    let down = ui.input(|i| i.pointer.press_origin()).or(response.interact_pointer_pos());
                    let grab = down.map_or(Grab::Move, |p| grab_part(p.x, block));
                    self.blur_grab = Some((blur.id.clone(), grab, blur.start, blur.end, down.map_or(block.center().x, |p| p.x)));
                }
                if response.dragged() {
                    if let (Some((id, grab, start, end, x)), Some(p)) = (&self.blur_grab, response.interact_pointer_pos()) {
                        if id == &blur.id {
                            moved = Some((blur.id.clone(), *grab, *start, *end, ((p.x - x) / pps) as f64));
                        }
                    }
                }
                if response.drag_stopped() {
                    self.blur_grab = None;
                    dropped = true;
                }
            }
            if grabbed {
                history.record(project);
            }
            if let Some((id, grab, start, end, dt)) = moved {
                if let Some(blur) = project.blur_mut(&id) {
                    const SHORTEST: f64 = 0.1;
                    match grab {
                        Grab::Move => {
                            let dt = dt.max(-start);
                            (blur.start, blur.end) = (start + dt, end + dt);
                        }
                        Grab::Start => blur.start = (start + dt).clamp(0.0, end - SHORTEST),
                        Grab::End => blur.end = (end + dt).max(start + SHORTEST),
                    }
                    output.changed = true;
                }
            }
            if dropped {
                output.changed = true;
            }
        }

        // An active move or trim follows the pointer until release.
        let mut grew = 0.0;
        let (mut moved, mut insert_line) = (None, None);
        if let (Some(gesture), Some(p)) = (&self.gesture, ui.input(|i| i.pointer.interact_pos())) {
            if ui.input(|i| i.pointer.primary_down()) {
                let t = t_of(p.x);
                match gesture {
                    Gesture::Move {
                        clip,
                        grab,
                        ids,
                        track,
                        base,
                        last,
                    } => {
                        if let Some(was) = base.clip(clip) {
                            // Snapped against the clips that stay (as they were), by whichever edge is nearer a point.
                            let family = base.with_linked(ids);
                            let ignore: Vec<&str> = family.iter().map(String::as_str).collect();
                            let start = t - grab;
                            let snapped_start = self.snap(base, &ignore, playhead, start);
                            let snapped_end =
                                self.snap(base, &ignore, playhead, start + was.duration) - was.duration;
                            let start =
                                if (snapped_start - start).abs() <= (snapped_end - start).abs() {
                                    snapped_start
                                } else {
                                    snapped_end
                                };
                            let hovered = row_at(p.y);
                            let rows = if hovered >= 0.0 && (hovered as usize) < base.tracks.len() {
                                hovered as isize - *track as isize
                            } else {
                                0
                            };
                            let now = (start - was.start, rows);
                            if *last != Some(now) {
                                *project = (**base).clone();
                                let landing = project.move_clips(ids, now.0, now.1);
                                insert_line = Some(landing.and_then(|l| l.insert_at));
                                moved = Some(now);
                                output.changed = true;
                            }
                        }
                    }
                    // The cut snaps to anything but the two clips it joins (their edges are the cut).
                    Gesture::Roll { left, right } => {
                        output.changed |= project.roll(
                            left,
                            right,
                            self.snap(project, &[left.as_str(), right.as_str()], playhead, t),
                        )
                    }
                    Gesture::Slide { clip, grab } => {
                        let duration = project.clip(clip).map_or(0.0, |c| c.duration);
                        let (left, right) =
                            (project.left_neighbor(clip), project.right_neighbor(clip));
                        let ignore: Vec<&str> =
                            [Some(clip.as_str()), left.as_deref(), right.as_deref()]
                                .into_iter()
                                .flatten()
                                .collect();
                        let start = t - grab;
                        let snapped_start = self.snap(project, &ignore, playhead, start);
                        let snapped_end =
                            self.snap(project, &ignore, playhead, start + duration) - duration;
                        let start = if (snapped_start - start).abs() <= (snapped_end - start).abs()
                        {
                            snapped_start
                        } else {
                            snapped_end
                        };
                        output.changed |= project.slide(clip, start);
                    }
                    // Dragging right shows earlier footage, as the picture follows the pointer.
                    Gesture::Slip {
                        clip,
                        from,
                        source_in,
                    } => {
                        let speed = project.clip(clip).map_or(1.0, |c| c.speed);
                        output.changed |= project.slip(clip, source_in - (t - from) * speed);
                    }
                    // Past the very start of the timeline, the clip keeps growing into earlier footage and everything
                    // after it moves later: `grown` is how far that has gone, so holding still doesn't grow it more.
                    Gesture::TrimStart { clip, grown } => {
                        let at_start = project.clip(clip).is_some_and(|c| c.start < 1e-6);
                        if t < 0.0 && at_start {
                            let more = -t - *grown;
                            if more > 0.0 {
                                grew = project.extend_start(clip, more);
                                output.changed |= grew > 0.0;
                            }
                        } else {
                            output.changed |= project
                                .trim_start(clip, self.snap(project, &[clip.as_str()], playhead, t))
                        }
                    }
                    Gesture::TrimEnd(clip) => {
                        output.changed |= project
                            .trim_end(clip, self.snap(project, &[clip.as_str()], playhead, t))
                    }
                }
                ui.ctx()
                    .set_cursor_icon(if matches!(gesture, Gesture::Move { .. }) {
                        CursorIcon::Grabbing
                    } else {
                        CursorIcon::ResizeHorizontal
                    });
            } else {
                self.gesture = None;
            }
        }
        if let Some(Gesture::TrimStart { grown, .. }) = &mut self.gesture {
            *grown += grew;
        }
        if let (Some(Gesture::Move { last, .. }), Some(now)) = (&mut self.gesture, moved) {
            *last = Some(now);
        }
        if let Some(line) = insert_line {
            self.insert_line = line;
        }

        // Dragging on an empty lane draws a box: everything it touches is picked, as on the desktop (with Shift or
        // Ctrl held, added to what was picked). Clicking an empty lane, or clicking or dragging on the ruler, moves
        // the playhead.
        if background.drag_started() {
            let origin = ui.input(|i| i.pointer.press_origin()).or(background.interact_pointer_pos());
            if let Some(p) = origin.filter(|p| p.x >= lanes.left() && p.y > ruler.bottom()) {
                let add = ui.input(|i| i.modifiers.shift || i.modifiers.command);
                self.marquee = Some(Marquee {
                    from: (t_of(p.x), p.y + vscroll),
                    keep: if add { self.selection.clone() } else { Vec::new() },
                });
            }
        }
        if !background.dragged() {
            self.marquee = None;
        }
        if let (Some(marquee), Some(p)) = (&self.marquee, background.interact_pointer_pos()) {
            let area = Rect::from_two_pos(pos2(x_of(marquee.from.0), marquee.from.1 - vscroll), p)
                .intersect(lane_area);
            let mut picked = marquee.keep.clone();
            // What the box covers in time runs from where it began to the pointer, wherever the timeline has scrolled.
            let x = p.x.clamp(lanes.left(), rect.right());
            let (t0, t1) = (marquee.from.0.min(t_of(x)), marquee.from.0.max(t_of(x)));
            let y = p.y + vscroll;
            let (y0, y1) = (marquee.from.1.min(y), marquee.from.1.max(y));
            let touched = |(_, start, end, top, bottom): &&(String, f64, f64, f32, f32)| {
                *start <= t1 && *end >= t0 && *top <= y1 && *bottom >= y0
            };
            for (id, ..) in boxes.iter().filter(touched) {
                if !picked.contains(id) {
                    picked.push(id.clone());
                }
            }
            self.selection = picked;
            painter.rect_filled(area, 2, color::SELECT_LINE.gamma_multiply(0.12));
            painter.rect_stroke(area, 2, Stroke::new(1.0, color::SELECT_LINE), StrokeKind::Inside);
            // Near either end of the lanes, the timeline scrolls so the box can reach further.
            let edge = 28.0;
            let step = if p.x > rect.right() - edge {
                (p.x - (rect.right() - edge)) / edge
            } else if p.x < lanes.left() + edge && self.scroll > 0.0 {
                -((lanes.left() + edge - p.x) / edge)
            } else {
                0.0
            };
            if step != 0.0 {
                self.scroll = (self.scroll + (step.clamp(-1.0, 1.0) * 12.0 / pps) as f64).max(0.0);
                ui.ctx().request_repaint();
            }
        } else if self.gesture.is_none() && (background.clicked() || background.dragged()) {
            if let Some(p) = background
                .interact_pointer_pos()
                .filter(|p| p.x >= lanes.left())
            {
                output.seek = Some(t_of(p.x).max(0.0));
                if background.clicked() && !clicked_clip && p.y > ruler.bottom() {
                    self.selection.clear();
                }
            }
        }

        // Wheel scrolls through time; Shift+wheel scrolls the rows up and down; Ctrl+wheel zooms around the pointer.
        if let Some(p) = pointer.filter(|p| rect.contains(*p)) {
            let (zoom, delta, shift) =
                ui.input(|i| (i.zoom_delta(), i.smooth_scroll_delta(), i.modifiers.shift));
            if zoom != 1.0 {
                let anchor = t_of(p.x);
                self.pps = (self.pps * zoom).clamp(2.0, 600.0);
                self.scroll = (anchor - ((p.x - lanes.left()) / self.pps) as f64).max(0.0);
            } else if shift && (delta.x != 0.0 || delta.y != 0.0) {
                // egui turns Shift+wheel sideways; down the wheel is down the rows either way.
                self.vscroll = (self.vscroll - (delta.x + delta.y)).clamp(0.0, overflow);
            } else if delta.x != 0.0 || delta.y != 0.0 {
                self.scroll = (self.scroll - ((delta.x + delta.y) / self.pps) as f64).max(0.0);
            }
        }

        // When the rows don't all fit, a thin bar at the right edge shows where they're scrolled to.
        if overflow > 0.0 {
            let track = Rect::from_min_max(pos2(rect.right() - 6.0, body.top() + 2.0), rect.max - vec2(2.0, 2.0));
            let shown = body.height() / (body.height() + overflow);
            let thumb_h = (track.height() * shown).max(18.0);
            let top = track.top() + (track.height() - thumb_h) * (vscroll / overflow);
            painter.rect_filled(track, 2, color::VEIL);
            painter.rect_filled(
                Rect::from_min_size(pos2(track.left(), top), vec2(track.width(), thumb_h)),
                2,
                color::INK_FAINT,
            );
        }

        // Drops from the media bin or Canopy's sidebar land at the pointer, on the row under it. Media from the bin is
        // put on the timeline as soon as it's over the lanes, so the clips there make room before it's let go.
        let over_lanes = pointer.filter(|p| lanes.contains(*p));
        let held = DragAndDrop::payload::<MediaDrag>(ui.ctx()).map(|m| m.0.clone());
        let released = ui.input(|i| i.pointer.any_released());
        match (held, over_lanes) {
            (Some(media), Some(p)) => {
                let base = match &self.drop_preview {
                    Some(preview) => &preview.base,
                    None => &*project,
                };
                let at = self.snap(base, &[], playhead, t_of(p.x).max(0.0));
                let hovered = row_at(p.y);
                let track = (hovered >= 0.0 && (hovered as usize) < base.tracks.len())
                    .then_some(hovered as usize);
                let preview = self.drop_preview.get_or_insert_with(|| DropPreview {
                    base: Box::new(project.clone()),
                    last: (String::new(), f64::NAN, None),
                    clip: None,
                    insert_at: None,
                });
                let now = (media.clone(), at, track);
                if preview.last != now {
                    *project = (*preview.base).clone();
                    // Nothing lands on a locked track.
                    let landed = track
                        .is_none_or(|t| !project.tracks[t].locked)
                        .then(|| project.place_at(&media, track, at))
                        .flatten();
                    (preview.clip, preview.insert_at) = match landed {
                        Some((id, Landing { insert_at, .. })) => (Some(id), insert_at),
                        None => (None, None),
                    };
                    preview.last = now;
                    output.changed = true;
                }
                if released {
                    // take_payload clears whatever payload there is, even one of another type: this one is ours.
                    DragAndDrop::take_payload::<MediaDrag>(ui.ctx());
                    if let Some(preview) = self.drop_preview.take() {
                        if let Some(id) = preview.clip {
                            history.record(&preview.base);
                            self.selection = vec![id];
                        }
                    }
                }
            }
            _ => {
                // Taken away from the lanes (or let go elsewhere): the project goes back to how it was.
                if let Some(preview) = self.drop_preview.take() {
                    *project = *preview.base;
                    output.changed = true;
                }
                if let Some(p) =
                    over_lanes.filter(|_| DragAndDrop::has_payload_of_type::<DraggedFiles>(ui.ctx()))
                {
                    painter.line_segment(
                        [pos2(p.x, rect.top() + RULER), pos2(p.x, rect.bottom())],
                        Stroke::new(2.0, color::SELECT_LINE),
                    );
                    if released {
                        let at = self.snap(project, &[], playhead, t_of(p.x).max(0.0));
                        let hovered = row_at(p.y);
                        let track = (hovered >= 0.0 && (hovered as usize) < project.tracks.len())
                            .then_some(hovered as usize);
                        if let Some(files) = DragAndDrop::take_payload::<DraggedFiles>(ui.ctx()) {
                            output.dropped = Some((files.0.clone(), at, track));
                        }
                    }
                }
            }
        }
        if let Some(preview) = &self.drop_preview {
            self.insert_line = preview.insert_at;
        } else if self.gesture.is_none() {
            self.insert_line = None;
        }

        // Where dragged clips go in between others: a line down the lanes at the cut, with a notch at each end.
        if let Some(cut) = self.insert_line {
            let x = x_of(cut);
            if x >= lanes.left() && x <= rect.right() {
                let (top, bottom) = (rect.top() + RULER, row(project.tracks.len()).top().max(rect.top() + RULER));
                painter.line_segment([pos2(x, top), pos2(x, bottom)], Stroke::new(3.0, color::SELECT_LINE));
                for (y, dir) in [(top, 1.0), (bottom, -1.0)] {
                    painter.add(egui::Shape::convex_polygon(
                        vec![pos2(x - 6.0, y), pos2(x + 6.0, y), pos2(x, y + 7.0 * dir)],
                        color::SELECT_LINE,
                        Stroke::NONE,
                    ));
                }
            }
        }

        // Playhead
        let x = x_of(playhead);
        if x >= lanes.left() && x <= rect.right() {
            painter.line_segment(
                [pos2(x, rect.top()), pos2(x, rect.bottom())],
                Stroke::new(1.5, color::SUN),
            );
            painter.add(egui::Shape::convex_polygon(
                vec![
                    pos2(x - 5.0, rect.top()),
                    pos2(x + 5.0, rect.top()),
                    pos2(x, rect.top() + 7.0),
                ],
                color::SUN,
                Stroke::NONE,
            ));
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{Attributes, Media};
    use egui::{Event, PointerButton, Pos2, RawInput};
    use std::path::PathBuf;

    /// A timeline at 30 pixels a second, with four 4-second clips end to end on the video track (0 to 16 s).
    struct Bench {
        ctx: egui::Context,
        timeline: Timeline,
        project: Project,
        history: History,
        looks: Looks,
        clips: Vec<String>,
        footage: String,
        area: Rect,
        time: f64,
    }

    impl Bench {
        fn new() -> Self {
            let mut project = Project::new("Drag");
            let footage = project.add_media(Media {
                id: "m".into(),
                path: PathBuf::from("C:/missing.mp4"),
                name: "m".into(),
                kind: MediaKind::Video,
                duration: 4.0,
                width: 1920,
                height: 1080,
                has_audio: true,
                frame_rate: 30.0,
                attributes: Attributes::default(),
            });
            let clips = (0..4).map(|i| project.place(&footage, Some(0), i as f64 * 4.0).unwrap()).collect();
            let timeline = Timeline { pps: 30.0, snap: false, ..Default::default() };
            let mut bench = Self {
                ctx: egui::Context::default(),
                timeline,
                project,
                history: History::default(),
                looks: Looks::default(),
                clips,
                footage,
                area: Rect::NOTHING,
                time: 0.0,
            };
            bench.frame(Vec::new());
            bench
        }

        fn frame(&mut self, events: Vec<Event>) {
            self.time += 0.5;
            let input = RawInput {
                screen_rect: Some(Rect::from_min_size(pos2(0.0, 0.0), vec2(1400.0, 600.0))),
                time: Some(self.time),
                events,
                ..Default::default()
            };
            let Self { ctx, timeline, project, history, looks, area, .. } = self;
            let mut output = ctx.run_ui(input, |ui| {
                *area = ui.available_rect_before_wrap();
                timeline.ui(ui, project, history, 0.0, looks);
            });
            output.textures_delta.clear();
        }

        /// Where time `t` is on the first track's row.
        fn at(&self, t: f64) -> Pos2 {
            pos2(self.area.left() + HEADER + t as f32 * 30.0, self.area.top() + RULER + ROW / 2.0)
        }

        fn press(&mut self, p: Pos2, pressed: bool) {
            self.frame(vec![
                Event::PointerMoved(p),
                Event::PointerButton { pos: p, button: PointerButton::Primary, pressed, modifiers: Default::default() },
            ]);
        }

        /// Takes hold at time `from` and moves to `to` (in steps, as a hand would), without letting go.
        fn drag(&mut self, from: f64, to: f64) {
            let p = self.at(from);
            self.frame(vec![Event::PointerMoved(p)]);
            self.press(p, true);
            for i in 1..=4 {
                let t = from + (to - from) * i as f64 / 4.0;
                self.frame(vec![Event::PointerMoved(self.at(t))]);
            }
        }

        fn starts(&self) -> Vec<f64> {
            self.clips.iter().map(|id| (self.project.clip(id).unwrap().start * 1000.0).round() / 1000.0).collect()
        }
    }

    fn wheel(bench: &mut Bench, down: f32, shift: bool) {
        let modifiers = egui::Modifiers { shift, ..Default::default() };
        let p = bench.at(2.0);
        bench.frame(vec![
            Event::PointerMoved(p),
            Event::ModifiersChanged(modifiers),
            Event::MouseWheel {
                unit: egui::MouseWheelUnit::Point,
                delta: vec2(0.0, -down),
                phase: egui::TouchPhase::Move,
                source: egui::MouseWheelSource::Wheel,
                modifiers,
            },
        ]);
        // The wheel is smoothed over a few frames.
        for _ in 0..10 {
            bench.frame(vec![Event::PointerMoved(p)]);
        }
    }

    #[test]
    fn shift_wheel_scrolls_the_rows_when_they_dont_all_fit() {
        let mut bench = Bench::new();
        // Nothing to scroll while everything fits.
        wheel(&mut bench, 200.0, true);
        assert_eq!(bench.timeline.vscroll, 0.0);
        // Seven titles at once: seven text tracks, more rows than the 600-pixel window has room for.
        for _ in 0..7 {
            bench.project.add_title(1.0);
        }
        bench.frame(Vec::new());
        wheel(&mut bench, 200.0, true);
        assert!(bench.timeline.vscroll > 0.0, "scrolled down {}", bench.timeline.vscroll);
        assert_eq!(bench.timeline.scroll, 0.0, "Shift+wheel doesn't move through time");
        // Never past the last row, and back up to the top.
        wheel(&mut bench, 5000.0, true);
        let rows = bench.project.tracks.len() + 1 + 7;
        assert_eq!(bench.timeline.vscroll, RULER + rows as f32 * ROW - 600.0);
        wheel(&mut bench, -5000.0, true);
        assert_eq!(bench.timeline.vscroll, 0.0);
        // The wheel alone still moves through time.
        wheel(&mut bench, 200.0, false);
        assert!(bench.timeline.scroll > 0.0);
        assert_eq!(bench.timeline.vscroll, 0.0);
    }

    #[test]
    fn a_title_dragged_down_goes_on_that_text_track() {
        let mut bench = Bench::new();
        let a = bench.project.add_title(2.0);
        let b = bench.project.add_title(2.0);
        let c = bench.project.add_title(10.0);
        bench.frame(Vec::new());
        let rows = |bench: &Bench| {
            let rows = bench.project.title_rows();
            [&a, &b, &c].map(|id| rows[bench.project.titles.iter().position(|t| &t.id == id).unwrap()])
        };
        assert_eq!(rows(&bench), [0, 1, 0]);
        // The third, held by its middle on the first text track and taken down one row, onto the second.
        let first_text = (bench.project.tracks.len() + 1) as f32;
        let on = |bench: &Bench, k: f32| bench.at(11.5) + vec2(0.0, (first_text + k) * ROW - ROW / 2.0 + 20.0);
        let from = on(&bench, 0.0);
        bench.frame(vec![Event::PointerMoved(from)]);
        bench.press(from, true);
        for i in 1..=4 {
            bench.frame(vec![Event::PointerMoved(from + vec2(0.0, ROW * i as f32 / 4.0))]);
        }
        bench.press(on(&bench, 1.0), false);
        bench.frame(Vec::new());
        assert_eq!(rows(&bench), [0, 1, 1]);
        assert_eq!(bench.project.titles.iter().find(|t| t.id == c).unwrap().start, 10.0);
    }

    /// A title's edges change how long it shows, like a clip's, even when the drag sets off quickly from the edge (the
    /// pointer is well past the edge by the time egui calls it a drag) or from just outside it.
    #[test]
    fn a_title_is_trimmed_by_dragging_its_edges() {
        let mut bench = Bench::new();
        let id = bench.project.add_title(2.0);
        bench.frame(Vec::new());
        let span = |bench: &Bench| {
            let t = bench.project.titles.iter().find(|t| t.id == id).unwrap();
            (t.start, t.end)
        };
        assert_eq!(span(&bench), (2.0, 5.0));
        let first_text = (bench.project.tracks.len() + 1) as f32;
        let on_title = |bench: &Bench, t: f64| bench.at(t) + vec2(0.0, first_text * ROW - ROW / 2.0 + 20.0);
        let drag = |bench: &mut Bench, from: Pos2, by: f32| {
            bench.frame(vec![Event::PointerMoved(from)]);
            bench.press(from, true);
            for i in 1..=4 {
                bench.frame(vec![Event::PointerMoved(from + vec2(by * i as f32 / 4.0, 0.0))]);
            }
            bench.press(from + vec2(by, 0.0), false);
            bench.frame(Vec::new());
        };
        // The right edge, from 2 px inside, 2 s later (60 px at 30 px a second): it shows longer.
        let from = on_title(&bench, 5.0) - vec2(2.0, 0.0);
        drag(&mut bench, from, 60.0);
        assert_eq!(span(&bench), (2.0, 7.0));
        // The left edge, from 3 px outside it, 1 s earlier: it starts sooner, its end stays.
        let from = on_title(&bench, 2.0) - vec2(3.0, 0.0);
        drag(&mut bench, from, -30.0);
        assert_eq!(span(&bench), (1.0, 7.0));
        // The right edge back in by 4 s: shorter.
        let from = on_title(&bench, 7.0) + vec2(1.0, 0.0);
        drag(&mut bench, from, -120.0);
        assert_eq!(span(&bench), (1.0, 3.0));
        // Its middle still moves it whole.
        let from = on_title(&bench, 2.0);
        drag(&mut bench, from, 30.0);
        assert_eq!(span(&bench), (2.0, 4.0), "moved whole");
    }

    /// Blurs sit on their own row: a drag from an edge changes when it starts or ends, from the middle moves it.
    #[test]
    fn a_blur_is_moved_and_trimmed_on_its_row() {
        let mut bench = Bench::new();
        let id = bench.project.add_blur(2.0, 5.0);
        bench.frame(Vec::new());
        let span = |bench: &Bench| {
            let b = bench.project.blurs.iter().find(|b| b.id == id).unwrap();
            (b.start, b.end)
        };
        // No titles or captions: the blur row comes right after the tracks and the drop row.
        let first_blur = (bench.project.tracks.len() + 1) as f32;
        let on_row = |bench: &Bench, t: f64| bench.at(t) + vec2(0.0, first_blur * ROW - ROW / 2.0 + 20.0);
        let drag = |bench: &mut Bench, from: Pos2, by: f32| {
            bench.frame(vec![Event::PointerMoved(from)]);
            bench.press(from, true);
            for i in 1..=4 {
                bench.frame(vec![Event::PointerMoved(from + vec2(by * i as f32 / 4.0, 0.0))]);
            }
            bench.press(from + vec2(by, 0.0), false);
            bench.frame(Vec::new());
        };
        let from = on_row(&bench, 5.0) - vec2(2.0, 0.0);
        drag(&mut bench, from, 60.0);
        assert_eq!(span(&bench), (2.0, 7.0));
        let from = on_row(&bench, 2.0) + vec2(2.0, 0.0);
        drag(&mut bench, from, 30.0);
        assert_eq!(span(&bench), (3.0, 7.0));
        let from = on_row(&bench, 5.0);
        drag(&mut bench, from, -60.0);
        assert_eq!(span(&bench), (1.0, 5.0));
        assert_eq!(bench.timeline.selection, [id.clone()]);
        // One undo per drag.
        assert!(bench.history.undo(&mut bench.project));
        assert_eq!(span(&bench), (3.0, 7.0));
    }

    #[test]
    fn dragging_a_selected_clip_takes_the_others_along() {
        let mut bench = Bench::new();
        bench.timeline.selection = vec![bench.clips[0].clone(), bench.clips[2].clone()];
        // The first clip, held in its middle, 20 seconds later: the third goes with it, 8 seconds behind.
        bench.drag(2.0, 22.0);
        assert_eq!(bench.starts(), [20.0, 4.0, 28.0, 12.0]);
        bench.press(bench.at(22.0), false);
        bench.frame(Vec::new());
        assert_eq!(bench.starts(), [20.0, 4.0, 28.0, 12.0]);
        assert_eq!(bench.timeline.selection.len(), 2);
        // One undo puts both back.
        assert!(bench.history.undo(&mut bench.project));
        assert_eq!(bench.starts(), [0.0, 4.0, 8.0, 12.0]);
    }

    #[test]
    fn a_clip_dragged_between_others_goes_in_and_they_make_room() {
        let mut bench = Bench::new();
        // The last clip, held in its middle, over the second one's start: while held, the second and third have
        // moved on to make room and a line marks the cut it goes in at.
        bench.drag(14.0, 6.5);
        assert_eq!(bench.starts(), [0.0, 8.0, 12.0, 4.0]);
        assert_eq!(bench.timeline.insert_line, Some(4.0));
        // Taken back to where it was, everything is as it was.
        bench.frame(vec![Event::PointerMoved(bench.at(14.0))]);
        assert_eq!(bench.starts(), [0.0, 4.0, 8.0, 12.0]);
        assert_eq!(bench.timeline.insert_line, None);
        // Over the cut again and let go: it stays in.
        bench.frame(vec![Event::PointerMoved(bench.at(6.5))]);
        bench.press(bench.at(6.5), false);
        bench.frame(Vec::new());
        assert_eq!(bench.starts(), [0.0, 8.0, 12.0, 4.0]);
        assert_eq!(bench.timeline.insert_line, None);
    }

    #[test]
    fn a_box_dragged_over_empty_lane_picks_what_it_touches() {
        let mut bench = Bench::new();
        // Under the clips (an empty lane) from 3 s to 9 s, up into the clips' row: the first three are touched.
        let below = |b: &Bench, t: f64| pos2(b.at(t).x, b.at(t).y + ROW + 10.0);
        let (from, to) = (below(&bench, 3.0), bench.at(9.0));
        bench.frame(vec![Event::PointerMoved(from)]);
        bench.press(from, true);
        for i in 1..=4 {
            let p = from + (to - from) * i as f32 / 4.0;
            bench.frame(vec![Event::PointerMoved(p)]);
        }
        let picked = bench.clips[..3].to_vec();
        assert_eq!(bench.timeline.selection, picked);
        // Back down off the third: it lets go of it while the box is still out.
        bench.frame(vec![Event::PointerMoved(below(&bench, 6.0) - vec2(0.0, ROW))]);
        assert_eq!(bench.timeline.selection, bench.clips[..2].to_vec());
        bench.press(below(&bench, 6.0) - vec2(0.0, ROW), false);
        bench.frame(Vec::new());
        assert_eq!(bench.timeline.selection, bench.clips[..2].to_vec());
        // Nothing moved, and the playhead wasn't asked to go anywhere by the box.
        assert_eq!(bench.starts(), [0.0, 4.0, 8.0, 12.0]);
        // With Shift held, a second box adds the last clip to them.
        let (from, to) = (below(&bench, 15.0), bench.at(13.0));
        bench.frame(vec![Event::PointerMoved(from)]);
        let shift = egui::Modifiers { shift: true, ..Default::default() };
        bench.frame(vec![
            Event::ModifiersChanged(shift),
            Event::PointerMoved(from),
            Event::PointerButton { pos: from, button: PointerButton::Primary, pressed: true, modifiers: shift },
        ]);
        for i in 1..=4 {
            let p = from + (to - from) * i as f32 / 4.0;
            bench.frame(vec![Event::PointerMoved(p)]);
        }
        bench.frame(vec![Event::ModifiersChanged(Default::default())]);
        assert_eq!(bench.timeline.selection, [&bench.clips[..2], &bench.clips[3..]].concat());
        // A plain click on the empty lane lets go of everything.
        bench.press(to, false);
        let empty = below(&bench, 30.0);
        bench.frame(vec![Event::PointerMoved(empty)]);
        bench.press(empty, true);
        bench.press(empty, false);
        bench.frame(Vec::new());
        assert!(bench.timeline.selection.is_empty());
    }

    #[test]
    fn clips_picked_by_a_box_stay_picked_when_they_scroll_out_of_sight() {
        let mut bench = Bench::new();
        let below = |b: &Bench, t: f64| pos2(b.at(t).x, b.at(t).y + ROW + 10.0);
        // A box from under the first clip over all four.
        let (from, to) = (below(&bench, 1.0), bench.at(14.0));
        bench.frame(vec![Event::PointerMoved(from)]);
        bench.press(from, true);
        for i in 1..=4 {
            let p = from + (to - from) * i as f32 / 4.0;
            bench.frame(vec![Event::PointerMoved(p)]);
        }
        assert_eq!(bench.timeline.selection, bench.clips);
        // Still holding, the wheel scrolls the timeline 10 seconds on: the first two clips are out of sight now,
        // and still picked; the pointer, now over 24 s, takes the box no further back.
        bench.frame(vec![Event::MouseWheel {
            unit: egui::MouseWheelUnit::Point,
            delta: vec2(-300.0, 0.0),
            phase: egui::TouchPhase::Move,
            source: egui::MouseWheelSource::Wheel,
            modifiers: Default::default(),
        }]);
        for _ in 0..4 {
            bench.frame(vec![Event::PointerMoved(to)]);
        }
        assert!(bench.timeline.scroll > 5.0, "scrolled to {}", bench.timeline.scroll);
        assert_eq!(bench.timeline.selection, bench.clips);
        bench.press(to, false);
        bench.frame(Vec::new());
        assert_eq!(bench.timeline.selection, bench.clips);
    }

    #[test]
    fn media_held_over_the_clips_makes_room_before_it_is_let_go() {
        let mut bench = Bench::new();
        DragAndDrop::set_payload(&bench.ctx, MediaDrag(bench.footage.clone()));
        // Held over the third clip, nearer its start: it's on the timeline already, and the clips after make room.
        bench.frame(vec![Event::PointerMoved(bench.at(8.5))]);
        assert_eq!(bench.starts(), [0.0, 4.0, 12.0, 16.0]);
        assert_eq!(bench.project.tracks[0].clips.len(), 5);
        assert_eq!(bench.timeline.insert_line, Some(8.0));
        // Taken off the lanes (over the track names): gone again.
        let names = pos2(bench.area.left() + 20.0, bench.at(0.0).y);
        bench.frame(vec![Event::PointerMoved(names)]);
        assert_eq!(bench.starts(), [0.0, 4.0, 8.0, 12.0]);
        assert_eq!(bench.project.tracks[0].clips.len(), 4);
        // Back over the cut and let go: it stays, picked, as one undo step.
        bench.frame(vec![Event::PointerMoved(bench.at(8.5))]);
        bench.press(bench.at(8.5), false);
        bench.frame(Vec::new());
        assert_eq!(bench.starts(), [0.0, 4.0, 12.0, 16.0]);
        assert_eq!(bench.project.tracks[0].clips.len(), 5);
        let new = bench.timeline.selection[0].clone();
        assert_eq!(bench.project.clip(&new).unwrap().start, 8.0);
        assert!(!DragAndDrop::has_any_payload(&bench.ctx));
        assert!(bench.history.undo(&mut bench.project));
        assert_eq!(bench.project.tracks[0].clips.len(), 4);
    }
}
