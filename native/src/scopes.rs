//! Video scopes over the preview picture, as the web StreamCuts' color page has them: a histogram of red, green and
//! blue, and a luma waveform (each column of the picture, its brightness from bottom to top). They measure the frame
//! the preview shows, every other pixel, and only while they're on.

use crate::ffmpeg::Frame;
use canopy_ui::{color, font};
use egui::{Align2, Color32, ColorImage, Painter, Rect, Stroke, TextureHandle, TextureOptions, pos2, vec2};

/// The waveform's size: columns across the picture, and brightness levels.
const COLUMNS: usize = 192;
const LEVELS: usize = 96;

/// How many pixels have each value, per channel (red, green, blue).
pub type Histogram = [[u32; 256]; 3];

#[derive(Default)]
pub struct Scopes {
    pub on: bool,
    histogram: Option<Box<Histogram>>,
    waveform: Option<TextureHandle>,
}

impl Scopes {
    /// Measures the picture the preview now shows, when the scopes are on.
    pub fn update(&mut self, ctx: &egui::Context, frame: &Frame) {
        if !self.on {
            return;
        }
        let (histogram, waveform) = measure(frame.size, &frame.rgba);
        self.histogram = Some(Box::new(histogram));
        match &mut self.waveform {
            Some(texture) => texture.set(waveform, TextureOptions::LINEAR),
            None => self.waveform = Some(ctx.load_texture("streamcuts-waveform", waveform, TextureOptions::LINEAR)),
        }
    }

    /// Draws them in `rect` on a dark card: the histogram above, the waveform below.
    pub fn draw(&self, painter: &Painter, rect: Rect) {
        painter.rect_filled(rect.expand(8.0), 8, Color32::from_black_alpha(210));
        let label = |at: Rect, text: &str| painter.text(at.left_top() + vec2(2.0, 0.0), Align2::LEFT_TOP, text, font::ui(10.0), color::INK_MUTED);
        let top = Rect::from_min_size(rect.min + vec2(0.0, 14.0), vec2(rect.width(), rect.height() * 0.42));
        let bottom = Rect::from_min_max(pos2(rect.left(), top.bottom() + 20.0), rect.max);
        label(rect, "Histogram");
        label(Rect::from_min_size(pos2(rect.left(), top.bottom() + 6.0), vec2(0.0, 0.0)), "Luma waveform");
        if let Some(histogram) = &self.histogram {
            // Scaled to the tallest bar away from the ends: a lot of pure black or white would flatten the rest.
            let tallest = histogram.iter().flat_map(|c| c[1..255].iter()).copied().max().unwrap_or(1).max(1) as f32;
            for (channel, ink) in [(0, Color32::from_rgb(255, 90, 90)), (1, Color32::from_rgb(90, 230, 110)), (2, Color32::from_rgb(110, 150, 255))] {
                let points = (0..256)
                    .map(|i| pos2(top.left() + top.width() * i as f32 / 255.0, top.bottom() - top.height() * (histogram[channel][i] as f32 / tallest).min(1.0)))
                    .collect();
                painter.add(egui::Shape::line(points, Stroke::new(1.0, ink)));
            }
        }
        painter.rect_stroke(bottom, 0, Stroke::new(1.0, color::HAIRLINE), egui::StrokeKind::Outside);
        if let Some(waveform) = &self.waveform {
            painter.image(waveform.id(), bottom, Rect::from_min_max(pos2(0.0, 0.0), pos2(1.0, 1.0)), Color32::WHITE);
        }
    }
}

/// The histogram and the luma waveform (as a picture: brighter where more of a column has that brightness) of an
/// RGBA picture `size` pixels across and down.
pub fn measure(size: [usize; 2], rgba: &[u8]) -> (Histogram, ColorImage) {
    let [width, height] = size;
    let mut histogram = [[0u32; 256]; 3];
    let mut counts = vec![0u32; COLUMNS * LEVELS];
    for y in (0..height).step_by(2) {
        for x in (0..width).step_by(2) {
            let p = &rgba[(y * width + x) * 4..][..3];
            for c in 0..3 {
                histogram[c][p[c] as usize] += 1;
            }
            // Rec. 709 luma, top row brightest.
            let luma = 0.2126 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.0722 * p[2] as f32;
            let level = (luma / 255.0 * (LEVELS - 1) as f32).round() as usize;
            counts[(LEVELS - 1 - level) * COLUMNS + x * COLUMNS / width] += 1;
        }
    }
    // A column whose pixels all share one brightness lights that spot fully; spread out, each spot is dimmer.
    let per_column = (width.div_ceil(2) * height.div_ceil(2)) as f32 / COLUMNS as f32;
    let pixels = counts
        .iter()
        .map(|&n| {
            let v = (n as f32 / per_column * 8.0).sqrt().min(1.0);
            Color32::from_rgb((v * 140.0) as u8, (v * 255.0) as u8, (v * 160.0) as u8)
        })
        .collect();
    (histogram, ColorImage { size: [COLUMNS, LEVELS], source_size: vec2(COLUMNS as f32, LEVELS as f32), pixels })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn black_and_white_halves_show_at_both_ends() {
        // Black on the left half, white on the right.
        let (width, height) = (384, 4);
        let rgba: Vec<u8> = (0..width * height).flat_map(|i| if i % width < width / 2 { [0, 0, 0, 255] } else { [255, 255, 255, 255] }).collect();
        let (histogram, waveform) = measure([width, height], &rgba);
        for channel in histogram {
            assert!(channel[0] > 0 && channel[0] == channel[255] && channel[1..255].iter().all(|&n| n == 0));
        }
        let at = |column: usize, row: usize| waveform.pixels[row * COLUMNS + column];
        // The left columns are bright at the bottom (black), the right ones at the top (white).
        assert!(at(0, LEVELS - 1) != Color32::BLACK && at(0, 0) == Color32::BLACK);
        assert!(at(COLUMNS - 1, 0) != Color32::BLACK && at(COLUMNS - 1, LEVELS - 1) == Color32::BLACK);
    }
}
