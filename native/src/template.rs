//! Animated title templates: a title with a look (slam, wave, typewriter, lower third, progress bar, pop box) whose
//! settings are all editable, like a DaVinci Fusion title's Inspector: words, font, colors, size, place, how long it
//! takes to come in and go out, and the letter-by-letter pace. One renderer draws a template at any moment of its life
//! into the part of the frame it can cover (its extent), for the preview and for exports alike, so they always match.

use crate::project::Title;
use ab_glyph::{Font, FontVec, GlyphId, PxScale, ScaleFont, point};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tiny_skia::{FillRule, Paint, PathBuilder, Pixmap, Rect, Transform};

mod forma_title;
pub use forma_title::{FormaTitle, FormaPreview, FormaFrame, catalog, load_forma, render_forma};

/// How a template looks and moves. Everything here is editable in the template's settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Look {
    pub kind: Kind,
    /// A second, smaller line (the lower third's role or tagline).
    #[serde(default)]
    pub subtitle: String,
    #[serde(default = "default_font")]
    pub font: String,
    /// The words' color, and the bar's, box's or fill's (`#rrggbb`).
    #[serde(default = "white")]
    pub color: String,
    #[serde(default = "red")]
    pub accent: String,
    /// Seconds it takes to come in and to go out.
    #[serde(default = "half")]
    pub in_secs: f32,
    #[serde(default = "third")]
    pub out_secs: f32,
    /// Seconds between one letter and the next (wave, typewriter).
    #[serde(default = "stagger")]
    pub stagger: f32,
    /// A soft drop shadow under the words.
    #[serde(default = "yes")]
    pub shadow: bool,
}

fn default_font() -> String {
    "Segoe UI".into()
}
fn white() -> String {
    "#ffffff".into()
}
fn red() -> String {
    "#e65443".into()
}
fn half() -> f32 {
    0.5
}
fn third() -> f32 {
    0.3
}
fn stagger() -> f32 {
    0.05
}
fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// Lands big and hard, with a little shake.
    Slam,
    /// Letters rise in one after another.
    Wave,
    /// Typed out letter by letter, with a cursor.
    Typewriter,
    /// A name and a role at the bottom left, behind a colored bar.
    LowerThird,
    /// A bar that fills across the frame over the template's time.
    Progress,
    /// Words in a colored pill that pops in.
    Pop,
}

impl Kind {
    pub const ALL: [Kind; 6] = [Kind::Slam, Kind::Wave, Kind::Typewriter, Kind::LowerThird, Kind::Progress, Kind::Pop];

    pub fn name(self) -> &'static str {
        match self {
            Kind::Slam => "Slam",
            Kind::Wave => "Wave reveal",
            Kind::Typewriter => "Typewriter",
            Kind::LowerThird => "Lower third",
            Kind::Progress => "Progress bar",
            Kind::Pop => "Pop box",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Kind::Slam => "Big words that land hard, with a little shake",
            Kind::Wave => "Letters rise in one after another",
            Kind::Typewriter => "Typed out letter by letter, with a cursor",
            Kind::LowerThird => "A name and what they do, at the bottom left",
            Kind::Progress => "A bar that fills across the frame",
            Kind::Pop => "Words in a colored pill that pops in",
        }
    }

    /// A new template of this kind: its look, and the title's words, place and size.
    pub fn start(self) -> (Look, String, f32, f32, f32) {
        let look = |font: &str, in_secs: f32, out_secs: f32, stagger: f32| Look {
            kind: self,
            subtitle: String::new(),
            font: font.into(),
            color: white(),
            accent: red(),
            in_secs,
            out_secs,
            stagger,
            shadow: true,
        };
        match self {
            Kind::Slam => (look("Impact", 0.35, 0.3, 0.05), "BIG MOMENT".into(), 0.5, 0.5, 0.14),
            Kind::Wave => (look("Segoe UI", 0.45, 0.3, 0.05), "Here we go".into(), 0.5, 0.5, 0.1),
            Kind::Typewriter => (look("Courier New", 0.3, 0.3, 0.06), "Typing this out...".into(), 0.5, 0.5, 0.07),
            Kind::LowerThird => (
                Look { subtitle: "What they do".into(), ..look("Segoe UI", 0.5, 0.4, 0.05) },
                "Your Name".into(),
                0.07,
                0.8,
                0.06,
            ),
            Kind::Progress => (look("Segoe UI", 0.3, 0.3, 0.05), String::new(), 0.5, 0.975, 0.012),
            Kind::Pop => (look("Arial Black", 0.4, 0.25, 0.05), "Subscribe!".into(), 0.5, 0.5, 0.07),
        }
    }
}

/// Fonts a template can use: the app's own, and bold faces Windows ships (by file in the Fonts folder).
pub const FONTS: [(&str, &str); 11] = [
    ("Nunito", ""),
    ("Arial Black", "ariblk.ttf"),
    ("Impact", "impact.ttf"),
    ("Segoe UI", "segoeuib.ttf"),
    ("Georgia", "georgiab.ttf"),
    ("Verdana", "verdanab.ttf"),
    ("Trebuchet MS", "trebucbd.ttf"),
    ("Calibri", "calibrib.ttf"),
    ("Comic Sans MS", "comicbd.ttf"),
    ("Courier New", "courbd.ttf"),
    ("Times New Roman", "timesbd.ttf"),
];

fn fonts_folder() -> PathBuf {
    std::env::var_os("WINDIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Windows")).join("Fonts")
}

/// A font by name, read once; the app's own when the name or file isn't there.
fn font(name: &str) -> Arc<FontVec> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<FontVec>>>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(Default::default).lock().unwrap();
    if let Some(font) = cache.get(name) {
        return font.clone();
    }
    let file = FONTS.iter().find(|f| f.0 == name).map_or("", |f| f.1);
    let font = (!file.is_empty())
        .then(|| std::fs::read(fonts_folder().join(file)).ok())
        .flatten()
        .and_then(|bytes| FontVec::try_from_vec(bytes).ok())
        .unwrap_or_else(|| FontVec::try_from_vec(crate::captions::font_bytes().to_vec()).expect("the app's own font"));
    let font = Arc::new(font);
    cache.insert(name.into(), font.clone());
    font
}

/// `#rrggbb` as numbers (white when it can't be read).
pub fn rgb(hex: &str) -> [u8; 3] {
    let channel = |i: usize| hex.get(i..i + 2).and_then(|c| u8::from_str_radix(c, 16).ok()).unwrap_or(255);
    if hex.len() == 7 && hex.starts_with('#') { [channel(1), channel(3), channel(5)] } else { [255, 255, 255] }
}

fn ease_out(p: f32) -> f32 {
    1.0 - (1.0 - p.clamp(0.0, 1.0)).powi(3)
}

/// Past 1 a little, then back: things that land with a bounce.
fn ease_out_back(p: f32) -> f32 {
    let (c1, p) = (1.70158, p.clamp(0.0, 1.0));
    1.0 + (c1 + 1.0) * (p - 1.0).powi(3) + c1 * (p - 1.0).powi(2)
}

/// Words laid out at a pixel size: each letter's glyph, its left edge and baseline (from the block's top-left), and
/// which letter (not counting spaces) it is.
struct Laid {
    glyphs: Vec<(GlyphId, f32, f32, usize)>,
    width: f32,
    height: f32,
    letters: usize,
    px: f32,
}

/// Lines (split at line breaks) centered on each other, or lined up on the left.
fn lay_out(font: &FontVec, text: &str, px: f32, centered: bool) -> Laid {
    let scaled = font.as_scaled(PxScale::from(px));
    let line_height = scaled.height() + scaled.line_gap();
    let mut lines = Vec::new();
    let mut letters = 0;
    for line in text.split('\n') {
        let (mut x, mut previous, mut glyphs) = (0.0, None, Vec::new());
        for c in line.chars() {
            let id = scaled.glyph_id(c);
            if let Some(previous) = previous {
                x += scaled.kern(previous, id);
            }
            glyphs.push((id, x, c.is_whitespace().then_some(usize::MAX).unwrap_or(letters)));
            if !c.is_whitespace() {
                letters += 1;
            }
            x += scaled.h_advance(id);
            previous = Some(id);
        }
        lines.push((x, glyphs));
    }
    let width = lines.iter().map(|(w, _)| *w).fold(0.0, f32::max);
    let mut glyphs = Vec::new();
    for (i, (line_width, line)) in lines.iter().enumerate() {
        let left = if centered { (width - line_width) / 2.0 } else { 0.0 };
        let baseline = scaled.ascent() + i as f32 * line_height;
        glyphs.extend(line.iter().map(|&(id, x, letter)| (id, left + x, baseline, letter)));
    }
    let height = lines.len() as f32 * line_height - scaled.line_gap();
    Laid { glyphs, width, height, letters, px }
}

/// What a template draws on: the part of a `w` x `h` frame from (`x0`, `y0`).
struct Canvas {
    pixmap: Pixmap,
    x0: f32,
    y0: f32,
}

impl Canvas {
    /// Lays `alpha` of color `c` on one pixel (premultiplied, over what's there).
    fn blend(&mut self, x: i32, y: i32, c: [u8; 3], alpha: f32) {
        let (w, h) = (self.pixmap.width() as i32, self.pixmap.height() as i32);
        if alpha <= 0.0 || x < 0 || y < 0 || x >= w || y >= h {
            return;
        }
        let a = alpha.min(1.0);
        let i = ((y * w + x) * 4) as usize;
        let data = self.pixmap.data_mut();
        for (k, value) in c.iter().enumerate() {
            data[i + k] = (*value as f32 * a + data[i + k] as f32 * (1.0 - a)).round() as u8;
        }
        data[i + 3] = (255.0 * a + data[i + 3] as f32 * (1.0 - a)).round() as u8;
    }

    /// One letter at `px`, its left edge at `x` and baseline at `y` (frame pixels).
    fn glyph(&mut self, font: &FontVec, id: GlyphId, px: f32, x: f32, y: f32, c: [u8; 3], alpha: f32) {
        let glyph = id.with_scale_and_position(PxScale::from(px), point(x - self.x0, y - self.y0));
        if let Some(outline) = font.outline_glyph(glyph) {
            let bounds = outline.px_bounds();
            outline.draw(|gx, gy, cover| {
                self.blend(bounds.min.x as i32 + gx as i32, bounds.min.y as i32 + gy as i32, c, cover * alpha);
            });
        }
    }

    /// Laid-out words with their top-left at (`x`, `y`); each letter can be moved and faded on its own.
    #[allow(clippy::too_many_arguments)]
    fn words(&mut self, font: &FontVec, laid: &Laid, x: f32, y: f32, c: [u8; 3], shadow: bool, each: impl Fn(usize) -> (f32, f32, f32), upto: usize) {
        let offset = laid.px * 0.045;
        let passes: &[(bool, [u8; 3], f32)] = if shadow { &[(true, [0, 0, 0], 0.5), (false, c, 1.0)] } else { &[(false, c, 1.0)] };
        for &(is_shadow, color, strength) in passes {
            for &(id, gx, gy, letter) in &laid.glyphs {
                let shown = if letter == usize::MAX { 0 } else { letter };
                if letter != usize::MAX && letter >= upto {
                    continue;
                }
                let (dx, dy, alpha) = each(shown);
                let shift = if is_shadow { offset } else { 0.0 };
                self.glyph(font, id, laid.px, x + gx + dx + shift, y + gy + dy + shift, color, alpha * strength);
            }
        }
    }

    fn rect(&mut self, x: f32, y: f32, w: f32, h: f32, radius: f32, c: [u8; 3], alpha: f32) {
        if alpha <= 0.0 || w <= 0.0 || h <= 0.0 {
            return;
        }
        let mut paint = Paint::default();
        paint.set_color_rgba8(c[0], c[1], c[2], (alpha.min(1.0) * 255.0).round() as u8);
        paint.anti_alias = true;
        let r = radius.min(w / 2.0).min(h / 2.0).max(0.0);
        let path = if r > 0.0 {
            let k = r * 0.552_285;
            let mut p = PathBuilder::new();
            p.move_to(x + r, y);
            p.line_to(x + w - r, y);
            p.cubic_to(x + w - r + k, y, x + w, y + r - k, x + w, y + r);
            p.line_to(x + w, y + h - r);
            p.cubic_to(x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h);
            p.line_to(x + r, y + h);
            p.cubic_to(x + r - k, y + h, x, y + h - r + k, x, y + h - r);
            p.line_to(x, y + r);
            p.cubic_to(x, y + r - k, x + r - k, y, x + r, y);
            p.close();
            p.finish()
        } else {
            Rect::from_xywh(x, y, w, h).map(PathBuilder::from_rect)
        };
        if let Some(path) = path {
            self.pixmap.fill_path(&path, &paint, FillRule::Winding, Transform::from_translate(-self.x0, -self.y0), None);
        }
    }
}

/// The template's parts at rest in a `w` x `h` frame: the words laid out, and the box everything fills (left, top,
/// right, bottom in pixels).
struct Parts {
    main: Laid,
    sub: Option<Laid>,
    rest: [f32; 4],
    look: Look,
}

fn parts(title: &Title, w: u32, h: u32) -> Option<Parts> {
    let look = title.look.clone()?;
    let (w, h) = (w as f32, h as f32);
    let px = (title.size * h).max(4.0);
    let font = font(&look.font);
    let (cx, cy) = (title.x * w, title.y * h);
    match look.kind {
        Kind::LowerThird => {
            let main = lay_out(&font, &title.text, px, false);
            let sub = (!look.subtitle.trim().is_empty()).then(|| lay_out(&font, &look.subtitle, px * 0.6, false));
            let pad = px * 0.35;
            let bar = (px * 0.12).max(3.0);
            let text_h = main.height + sub.as_ref().map_or(0.0, |s| s.height + px * 0.15);
            let text_w = main.width.max(sub.as_ref().map_or(0.0, |s| s.width));
            let rest = [cx, cy - text_h / 2.0 - pad, cx + bar + pad * 2.0 + text_w + pad, cy + text_h / 2.0 + pad];
            Some(Parts { main, sub, rest, look })
        }
        Kind::Progress => {
            let main = lay_out(&font, &title.text, (0.035 * h).max(8.0), false);
            let thick = (title.size * h).max(2.0);
            let top = if title.text.trim().is_empty() { cy - thick / 2.0 } else { cy - thick / 2.0 - main.height - thick };
            Some(Parts { main, sub: None, rest: [0.0, top, w, cy + thick / 2.0], look })
        }
        Kind::Pop => {
            let main = lay_out(&font, &title.text, px, true);
            let (pw, ph) = (main.width + px * 0.9, main.height + px * 0.6);
            Some(Parts { main, sub: None, rest: [cx - pw / 2.0, cy - ph / 2.0, cx + pw / 2.0, cy + ph / 2.0], look })
        }
        _ => {
            let main = lay_out(&font, &title.text, px, true);
            let rest = [cx - main.width / 2.0, cy - main.height / 2.0, cx + main.width / 2.0, cy + main.height / 2.0];
            Some(Parts { main, sub: None, rest, look })
        }
    }
}

/// Where a template sits at rest, as parts of the frame (left, top, right, bottom): what's picked and dragged on the
/// preview.
pub fn bounds(title: &Title, w: u32, h: u32) -> Option<[f32; 4]> {
    let p = parts(title, w, h)?;
    Some([p.rest[0] / w as f32, p.rest[1] / h as f32, p.rest[2] / w as f32, p.rest[3] / h as f32])
}

/// The part of a `w` x `h` frame a template can cover at any moment of its life (left, top, width, height: even
/// pixels inside the frame). Everything it draws is inside it.
pub fn extent(title: &Title, w: u32, h: u32) -> Option<(u32, u32, u32, u32)> {
    if title.forma.is_some() {
        return Some((0, 0, w, h));
    }
    let p = parts(title, w, h)?;
    let [l, t, r, b] = p.rest;
    let (cx, cy, bw, bh) = ((l + r) / 2.0, (t + b) / 2.0, r - l, b - t);
    let px = p.main.px;
    let margin = px * 0.15 + 2.0;
    let [l, t, r, b] = match p.look.kind {
        // The slam starts at 2.4 times its size, and shakes.
        Kind::Slam => [cx - bw * 1.25 - w as f32 * 0.015, cy - bh * 1.25, cx + bw * 1.25 + w as f32 * 0.015, cy + bh * 1.25],
        // Letters come up from below and bounce above.
        Kind::Wave => [l, t - px * 0.3, r, b + px * 0.8],
        Kind::Typewriter => [l, t, r + px * 0.2, b],
        // It slides in from the left.
        Kind::LowerThird => [l - w as f32 * 0.05, t, r, b],
        Kind::Pop => [cx - bw * 0.6, cy - bh * 0.6, cx + bw * 0.6, cy + bh * 0.6],
        Kind::Progress => [l, t, r, b],
    };
    let (l, t) = ((l - margin).max(0.0), (t - margin).max(0.0));
    let (r, b) = ((r + margin).min(w as f32), (b + margin).min(h as f32));
    let even_down = |v: f32| (v.max(0.0) as u32) / 2 * 2;
    let even_up = |v: f32, most: u32| ((v.ceil() as u32 + 1) / 2 * 2).min(most);
    let (x0, y0) = (even_down(l).min(w.saturating_sub(2)), even_down(t).min(h.saturating_sub(2)));
    let (x1, y1) = (even_up(r, w).max(x0 + 2), even_up(b, h).max(y0 + 2));
    Some((x0, y0, x1 - x0, y1 - y0))
}

/// The template `t` seconds into its life, drawn on its extent of a `w` x `h` frame (premultiplied RGBA), with where
/// that extent is.
pub fn render(title: &Title, t: f64, w: u32, h: u32) -> Option<(u32, u32, Pixmap)> {
    let p = parts(title, w, h)?;
    let (x0, y0, ew, eh) = extent(title, w, h)?;
    let mut c = Canvas { pixmap: Pixmap::new(ew, eh)?, x0: x0 as f32, y0: y0 as f32 };
    let look = &p.look;
    let font = font(&look.font);
    let (fw, fh) = (w as f32, h as f32);
    let life = (title.end - title.start).max(0.01) as f32;
    let t = (t as f32).clamp(0.0, life);
    let (ain, aout) = (look.in_secs.clamp(0.01, life), look.out_secs.clamp(0.01, life));
    // How far it has gone out (0 until its last `aout` seconds).
    let gone = ((t - (life - aout)) / aout).clamp(0.0, 1.0);
    let color = rgb(&look.color);
    let accent = rgb(&look.accent);
    let [l, top, r, b] = p.rest;
    let (cx, cy) = ((l + r) / 2.0, (top + b) / 2.0);
    let px = p.main.px;
    match look.kind {
        Kind::Slam => {
            let came = (t / ain).clamp(0.0, 1.0);
            let mut scale = 1.0 + 1.4 * (1.0 - ease_out(came));
            let mut alpha = (came * 3.0).min(1.0);
            let after = t - ain;
            let shake = if after > 0.0 && after < 0.25 { (after * 70.0).sin() * (0.25 - after) / 0.25 * fw * 0.01 } else { 0.0 };
            scale *= 1.0 - 0.15 * gone;
            alpha *= 1.0 - gone;
            let laid = lay_out(&font, &title.text, px * scale, true);
            c.words(&font, &laid, cx - laid.width / 2.0 + shake, cy - laid.height / 2.0, color, look.shadow, |_| (0.0, 0.0, alpha), usize::MAX);
        }
        Kind::Wave => {
            let laid = &p.main;
            let stagger = look.stagger.max(0.0);
            c.words(&font, laid, l, top, color, look.shadow, |i| {
                let came = ((t - i as f32 * stagger) / ain).clamp(0.0, 1.0);
                let rise = (1.0 - ease_out_back(came)) * 0.7 * px + gone * 0.4 * px;
                (0.0, rise, (came * 2.5).min(1.0) * (1.0 - gone))
            }, usize::MAX);
        }
        Kind::Typewriter => {
            let laid = &p.main;
            let pace = look.stagger.max(0.01);
            let typed = ((t / pace).floor() as usize + 1).min(laid.letters);
            let alpha = 1.0 - gone;
            c.words(&font, laid, l, top, color, look.shadow, |_| (0.0, 0.0, alpha), typed);
            // The cursor after the last letter typed, blinking once it's done.
            let done = typed >= laid.letters && t > laid.letters as f32 * pace + 0.1;
            if !done || (t * 2.0).fract() < 0.6 {
                let last = laid.glyphs.iter().filter(|g| g.3 != usize::MAX && g.3 + 1 == typed).last();
                let (x, baseline) = last.map_or((0.0, laid.glyphs.first().map_or(px * 0.8, |g| g.2)), |&(id, gx, gy, _)| {
                    (gx + font.as_scaled(PxScale::from(px)).h_advance(id), gy)
                });
                c.rect(l + x + px * 0.05, top + baseline - px * 0.7, px * 0.08, px * 0.8, 0.0, color, alpha);
            }
        }
        Kind::LowerThird => {
            let pad = px * 0.35;
            let bar = (px * 0.12).max(3.0);
            let grow = ease_out((t / (ain * 0.4)).clamp(0.0, 1.0));
            let came = ease_out(((t - ain * 0.25) / (ain * 0.75)).clamp(0.0, 1.0));
            let alpha = came * (1.0 - gone);
            let slide = -(1.0 - came) * fw * 0.04 - gone * fw * 0.04;
            let height = b - top;
            // The bar grows from its middle, then the panel and words slide out from behind it.
            c.rect(l, cy - height * grow / 2.0, bar, height * grow, 0.0, accent, 1.0 - gone);
            c.rect(l + bar + slide, top, r - l - bar, height, 0.0, [0, 0, 0], 0.45 * alpha);
            let x = l + bar + pad * 2.0 + slide;
            let words_top = cy - (p.main.height + p.sub.as_ref().map_or(0.0, |s| s.height + px * 0.15)) / 2.0;
            c.words(&font, &p.main, x, words_top, color, look.shadow, |_| (0.0, 0.0, alpha), usize::MAX);
            if let Some(sub) = &p.sub {
                c.words(&font, sub, x, words_top + p.main.height + px * 0.15, color, false, |_| (0.0, 0.0, alpha * 0.85), usize::MAX);
            }
        }
        Kind::Progress => {
            let alpha = (t / ain).clamp(0.0, 1.0) * (1.0 - gone);
            let thick = (title.size * fh).max(2.0);
            let bar_top = title.y * fh - thick / 2.0;
            c.rect(0.0, bar_top, fw, thick, 0.0, accent, 0.3 * alpha);
            c.rect(0.0, bar_top, fw * (t / life).clamp(0.0, 1.0), thick, 0.0, accent, alpha);
            if !title.text.trim().is_empty() {
                c.words(&font, &p.main, fw * 0.02, bar_top - thick - p.main.height, color, look.shadow, |_| (0.0, 0.0, alpha), usize::MAX);
            }
        }
        Kind::Pop => {
            let scale = ease_out_back(t / ain).max(0.0) * (1.0 - gone * 0.6);
            let alpha = (t / ain * 3.0).clamp(0.0, 1.0) * (1.0 - gone);
            if scale > 0.01 {
                let laid = lay_out(&font, &title.text, px * scale, true);
                let (pw, ph) = (laid.width + px * 0.9 * scale, laid.height + px * 0.6 * scale);
                c.rect(cx - pw / 2.0, cy - ph / 2.0, pw, ph, ph / 2.0, accent, alpha);
                c.words(&font, &laid, cx - laid.width / 2.0, cy - laid.height / 2.0, color, look.shadow, |_| (0.0, 0.0, alpha), usize::MAX);
            }
        }
    }
    Some((x0, y0, c.pixmap))
}

/// The pixels of a premultiplied pixmap as plain RGBA.
pub fn plain(pixmap: &Pixmap) -> Vec<u8> {
    pixmap.pixels().iter().flat_map(|p| {
        let c = p.demultiply();
        [c.red(), c.green(), c.blue(), c.alpha()]
    }).collect()
}

/// Writes a template's frames for an export into `folder` as PNGs, a new one only when the picture changes, with an
/// FFmpeg concat list (`tpl<k>.txt`) that holds each for as long as it lasts.
pub fn write_frames(title: &Title, k: usize, fps: u32, w: u32, h: u32, folder: &Path) -> Result<(), String> {
    let forma = title.forma.as_ref().map(|title| forma_title::instance(title, &folder.join("forma")));
    let life = (title.end - title.start).max(0.0);
    let frames = ((life * fps as f64).ceil() as usize).max(1);
    let mut list = String::from("ffconcat version 1.0\n");
    let mut held: Option<(String, Vec<u8>, usize)> = None;
    let flush = |held: &Option<(String, Vec<u8>, usize)>, list: &mut String| {
        if let Some((file, _, count)) = held {
            list.push_str(&format!("file '{file}'\noption framerate {fps}\nduration {:.6}\n", *count as f64 / fps as f64));
        }
    };
    for i in 0..frames {
        let time = i as f64 / fps as f64;
        let frame = if let Some(instance) = &forma {
            render_forma(title, instance, time, w, h).map(|pixels| (0, 0, pixels))
        } else {
            render(title, time, w, h)
        };
        let Some((_, _, pixmap)) = frame else {
            return Err("A template couldn't be drawn.".into());
        };
        let data = pixmap.data().to_vec();
        match &mut held {
            Some((_, last, count)) if *last == data => *count += 1,
            _ => {
                flush(&held, &mut list);
                let file = format!("tpl{k}_{i:06}.png");
                let mut png = Vec::new();
                image::ImageEncoder::write_image(
                    image::codecs::png::PngEncoder::new_with_quality(&mut png, image::codecs::png::CompressionType::Fast, image::codecs::png::FilterType::Sub),
                    &plain(&pixmap),
                    pixmap.width(),
                    pixmap.height(),
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|e| e.to_string())?;
                std::fs::write(folder.join(&file), png).map_err(|e| e.to_string())?;
                held = Some((file, data, 1));
            }
        }
    }
    flush(&held, &mut list);
    // The concat demuxer only keeps the last picture's duration when it's named once more.
    if let Some((file, ..)) = &held {
        list.push_str(&format!("file '{file}'\noption framerate {fps}\n"));
    }
    std::fs::write(folder.join(format!("tpl{k}.txt")), list).map_err(|e| e.to_string())
}

/// Templates kept for later ("Save as my template"): a name, the look, and the title's words, place and size. In
/// Canopy's profile folder, so they're there in every space.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub name: String,
    pub look: Look,
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub size: f32,
}

fn saved_file() -> PathBuf {
    canopy_ui::canopy_core::settings::profile_dir().join("streamcuts-templates.json")
}

pub fn saved() -> Vec<Saved> {
    std::fs::read(saved_file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save_all(all: &[Saved]) -> Result<(), String> {
    let file = saved_file();
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(file, serde_json::to_vec_pretty(all).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn template(kind: Kind) -> Title {
        let (look, text, x, y, size) = kind.start();
        Title { id: "t".into(), start: 0.0, end: 3.0, text, x, y, size, row: 0, look: Some(look), forma: None }
    }

    fn coverage(pixmap: &Pixmap) -> usize {
        pixmap.pixels().iter().filter(|p| p.alpha() > 0).count()
    }

    #[test]
    fn every_template_draws_inside_its_extent_and_comes_and_goes() {
        for kind in Kind::ALL {
            let title = template(kind);
            let (x, y, w, h) = extent(&title, 1920, 1080).unwrap();
            assert!(x + w <= 1920 && y + h <= 1080 && w % 2 == 0 && h % 2 == 0, "{kind:?}");
            let shown = |t: f64| coverage(&render(&title, t, 1920, 1080).unwrap().2);
            assert!(shown(1.5) > 50, "{kind:?} shows in its middle: {}", shown(1.5));
            assert!(shown(3.0) < shown(1.5) / 4 + 5, "{kind:?} is gone at its end: {} vs {}", shown(3.0), shown(1.5));
            let [l, t, r, b] = bounds(&title, 1920, 1080).unwrap();
            assert!(l < r && t < b, "{kind:?}");
        }
    }

    #[test]
    fn templates_move_the_way_their_names_say() {
        let at = |title: &Title, t: f64| render(title, t, 1920, 1080).unwrap().2;
        // A typewriter has typed more later on.
        let typed = template(Kind::Typewriter);
        assert!(coverage(&at(&typed, 0.3)) < coverage(&at(&typed, 1.2)));
        // A progress bar is fuller later on.
        let bar = template(Kind::Progress);
        let filled = |t: f64| at(&bar, t).pixels().iter().filter(|p| p.alpha() > 200).count();
        assert!(filled(0.6) < filled(2.0));
        // A slam is bigger as it comes in than once it has landed.
        let slam = template(Kind::Slam);
        let size = |t: f64| {
            let pixmap = at(&slam, t);
            let w = pixmap.width() as usize;
            let columns: Vec<usize> = pixmap.pixels().iter().enumerate().filter(|(_, p)| p.alpha() > 128).map(|(i, _)| i % w).collect();
            columns.iter().max().unwrap_or(&0) - columns.iter().min().unwrap_or(&0)
        };
        assert!(size(0.1) > size(1.5) * 6 / 5, "{} vs {}", size(0.1), size(1.5));
        // Its words are its own: a different text changes the picture.
        let mut other = slam.clone();
        other.text = "OTHER".into();
        assert_ne!(at(&slam, 1.5).data(), at(&other, 1.5).data());
    }
}
