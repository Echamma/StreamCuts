//! How captions look: white Nunito ExtraBold with a black outline, centered near the bottom of the frame. The preview
//! draws them with egui and exports burn them in from an ASS file through FFmpeg's `subtitles` filter, both from the
//! same proportions so what you see is what you get.

use crate::project::Project;
use canopy_ui::{CAPTION_FONT, font};
use egui::{Color32, Painter, Rect, pos2, vec2};

/// Text size, gap below the text, and widest line, as fractions of the frame's height (size, gap) and width.
const SIZE: f32 = 0.055;
const BOTTOM: f32 = 0.08;
const WIDTH: f32 = 0.86;
/// Outline thickness as a fraction of the text size.
const OUTLINE: f32 = 0.09;
/// FFmpeg's subtitle renderer (libass) draws a font smaller than egui does at the same size; measured on an export
/// against the preview, Nunito ExtraBold needs 1.385 times the size to come out the same width.
const ASS_SIZE: f32 = 1.385;

/// Draws `text` over a preview picture that fills `screen`.
pub fn draw(painter: &Painter, screen: Rect, text: &str) {
    let size = (screen.height() * SIZE).max(8.0);
    let galley = painter.layout(text.to_owned(), font::display(size), Color32::WHITE, screen.width() * WIDTH);
    let origin = pos2(screen.center().x - galley.size().x / 2.0, screen.bottom() - screen.height() * BOTTOM - galley.size().y);
    let outline = (size * OUTLINE).max(1.0);
    for (dx, dy) in [(-1.0, -1.0), (0.0, -1.0), (1.0, -1.0), (-1.0, 0.0), (1.0, 0.0), (-1.0, 1.0), (0.0, 1.0), (1.0, 1.0)] {
        painter.galley_with_override_text_color(origin + vec2(dx, dy) * outline, galley.clone(), Color32::BLACK);
    }
    painter.galley(origin, galley, Color32::WHITE);
}

/// The file name of the font exports hand to FFmpeg next to the ASS file.
pub const FONT_FILE: &str = "captions.ttf";

pub fn font_bytes() -> &'static [u8] {
    CAPTION_FONT.1
}

fn ass_time(t: f64) -> String {
    let centis = (t.max(0.0) * 100.0).round() as u64;
    format!("{}:{:02}:{:02}.{:02}", centis / 360_000, centis / 6000 % 60, centis / 100 % 60, centis % 100)
}

/// ASS text can't hold override braces or raw line breaks.
fn ass_text(text: &str) -> String {
    text.replace('\\', "/").replace('{', "(").replace('}', ")").replace('\n', "\\N")
}

/// The project's captions as an ASS subtitles file sized to its frame.
pub fn ass(project: &Project) -> String {
    let (w, h) = (project.width as f32, project.height as f32);
    let size = (h * SIZE * ASS_SIZE).round();
    let side = (w * (1.0 - WIDTH) / 2.0).round();
    let mut out = format!(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: {w}\nPlayResY: {h}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n\
         [V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n\
         Style: Default,{font},{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,{outline:.1},0,2,{side},{side},{bottom},1\n\n\
         [Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
        font = CAPTION_FONT.0,
        outline = h * SIZE * OUTLINE,
        bottom = (h * BOTTOM).round(),
    );
    for caption in &project.captions {
        out.push_str(&format!("Dialogue: 0,{},{},Default,,0,0,0,,{}\n", ass_time(caption.start), ass_time(caption.end), ass_text(&caption.text)));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::Caption;

    #[test]
    fn ass_holds_each_caption_with_its_times() {
        let mut project = Project::new("Captions");
        project.add_captions(0.0, 100.0, vec![
            Caption { id: "a".into(), start: 1.5, end: 2.756, text: "Hello {there}".into(), words: Vec::new() },
            Caption { id: "b".into(), start: 3725.0, end: 3726.0, text: "an hour in".into(), words: Vec::new() },
        ]);
        let ass = ass(&project);
        assert!(ass.contains("PlayResX: 1920\nPlayResY: 1080"));
        assert!(ass.contains("Style: Default,Nunito ExtraLight,82,"));
        assert!(ass.contains("Dialogue: 0,0:00:01.50,0:00:02.76,Default,,0,0,0,,Hello (there)\n"));
        assert!(ass.contains("Dialogue: 0,1:02:05.00,1:02:06.00,Default,,0,0,0,,an hour in\n"));
    }
}
