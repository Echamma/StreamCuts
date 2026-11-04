//! How text on the picture looks: white Nunito ExtraBold with a black outline, captions centered near the bottom of the
//! frame and titles wherever they're placed. The preview draws them with egui and exports burn them in from an ASS file
//! through FFmpeg's `subtitles` filter, both from the same proportions so what you see is what you get.

use crate::project::{Project, Title, word_spans};
use canopy_ui::{CAPTION_FONT, font};
use egui::{Color32, Painter, Rect, pos2, vec2};

/// Text size and widest line, as fractions of the frame's height and width. The gap under captions is the project's.
const SIZE: f32 = 0.055;
const WIDTH: f32 = 0.86;
/// Outline thickness as a fraction of the text size.
const OUTLINE: f32 = 0.09;
/// FFmpeg's subtitle renderer (libass) draws a font smaller than egui does at the same size; measured on an export
/// against the preview, Nunito ExtraBold needs 1.385 times the size to come out the same width.
const ASS_SIZE: f32 = 1.385;

/// The color of the word being said, in word-by-word captions (`HIGHLIGHT_ASS` is the same in ASS's blue-green-red).
const HIGHLIGHT: Color32 = Color32::from_rgb(255, 212, 0);
const HIGHLIGHT_ASS: &str = "&H00D4FF&";

/// Draws a caption over a preview picture that fills `screen`, `bottom` (a fraction of its height) above the bottom,
/// with its `word`th word lit up if given.
pub fn draw(painter: &Painter, screen: Rect, text: &str, word: Option<usize>, bottom: f32) {
    let lit = word.and_then(|i| word_spans(text).get(i).cloned());
    outlined(painter, screen, text, lit, SIZE, |size| {
        pos2(
            screen.center().x - size.x / 2.0,
            screen.bottom() - screen.height() * bottom - size.y,
        )
    });
}

/// Draws a title over a preview picture that fills `screen`, centered across and at its height.
pub fn draw_title(painter: &Painter, screen: Rect, title: &Title) {
    let y = screen.top() + screen.height() * title.y;
    outlined(painter, screen, &title.text, None, title.size, |size| {
        pos2(screen.center().x - size.x / 2.0, y - size.y / 2.0)
    });
}

/// White text with a black outline (the `lit` part of it highlighted), `size` a fraction of the picture's height, placed
/// by `origin` from its size.
fn outlined(
    painter: &Painter,
    screen: Rect,
    text: &str,
    lit: Option<std::ops::Range<usize>>,
    size: f32,
    origin: impl Fn(egui::Vec2) -> egui::Pos2,
) {
    let size = (screen.height() * size).max(8.0);
    let galley = match lit {
        Some(lit) => {
            let mut job = egui::text::LayoutJob::default();
            job.wrap.max_width = screen.width() * WIDTH;
            for (part, color) in [
                (0..lit.start, Color32::WHITE),
                (lit.clone(), HIGHLIGHT),
                (lit.end..text.len(), Color32::WHITE),
            ] {
                job.append(
                    &text[part],
                    0.0,
                    egui::TextFormat::simple(font::display(size), color),
                );
            }
            painter.layout_job(job)
        }
        None => painter.layout(
            text.to_owned(),
            font::display(size),
            Color32::WHITE,
            screen.width() * WIDTH,
        ),
    };
    let origin = origin(galley.size());
    let outline = (size * OUTLINE).max(1.0);
    for (dx, dy) in [
        (-1.0, -1.0),
        (0.0, -1.0),
        (1.0, -1.0),
        (-1.0, 0.0),
        (1.0, 0.0),
        (-1.0, 1.0),
        (0.0, 1.0),
        (1.0, 1.0),
    ] {
        painter.galley_with_override_text_color(
            origin + vec2(dx, dy) * outline,
            galley.clone(),
            Color32::BLACK,
        );
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
    format!(
        "{}:{:02}:{:02}.{:02}",
        centis / 360_000,
        centis / 6000 % 60,
        centis / 100 % 60,
        centis % 100
    )
}

/// ASS text can't hold override braces or raw line breaks.
fn ass_text(text: &str) -> String {
    text.replace('\\', "/")
        .replace('{', "(")
        .replace('}', ")")
        .replace('\n', "\\N")
}

/// The project's captions as an ASS subtitles file sized to its frame.
pub fn ass(project: &Project) -> String {
    let (w, h) = (project.width as f32, project.height as f32);
    let size = (h * SIZE * ASS_SIZE).round();
    let side = (w * (1.0 - WIDTH) / 2.0).round();
    let mut out = format!(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: {w}\nPlayResY: {h}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n\
         [V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n\
         Style: Default,{font},{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,{outline:.1},0,2,{side},{side},{bottom},1\n\
         Style: Title,{font},{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,{outline:.1},0,5,{side},{side},0,1\n\n\
         [Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
        font = CAPTION_FONT.0,
        outline = h * SIZE * OUTLINE,
        bottom = (h * project.caption_bottom).round(),
    );
    let line = |from: f64, to: f64, text: String| {
        format!(
            "Dialogue: 0,{},{},Default,,0,0,0,,{text}\n",
            ass_time(from),
            ass_time(to)
        )
    };
    for caption in &project.captions {
        let spans = word_spans(&caption.text);
        if !project.caption_words || caption.words.is_empty() || caption.words.len() != spans.len()
        {
            out.push_str(&line(caption.start, caption.end, ass_text(&caption.text)));
            continue;
        }
        // Word by word, as `Caption::word_at` has it: plain until the first word, then a line per word with it lit.
        let text = &caption.text;
        let first = caption.words[0].start.clamp(caption.start, caption.end);
        if first > caption.start {
            out.push_str(&line(caption.start, first, ass_text(text)));
        }
        for (i, (word, span)) in caption.words.iter().zip(&spans).enumerate() {
            let from = word.start.clamp(caption.start, caption.end);
            let to = caption
                .words
                .get(i + 1)
                .map_or(caption.end, |next| next.start)
                .min(caption.end);
            if to > from {
                let lit = format!(
                    "{}{{\\c{HIGHLIGHT_ASS}}}{}{{\\c&HFFFFFF&}}{}",
                    ass_text(&text[..span.start]),
                    ass_text(&text[span.clone()]),
                    ass_text(&text[span.end..])
                );
                out.push_str(&line(from, to, lit));
            }
        }
    }
    for title in &project.titles {
        // Placed and sized one by one: the middle of the text at the title's height, centered across.
        let (x, y, size) = (
            (w / 2.0).round(),
            (h * title.y).round(),
            (h * title.size * ASS_SIZE).round(),
        );
        let outline = h * title.size * OUTLINE;
        out.push_str(&format!(
            "Dialogue: 1,{},{},Title,,0,0,0,,{{\\pos({x},{y})\\fs{size}\\bord{outline:.1}}}{}\n",
            ass_time(title.start),
            ass_time(title.end),
            ass_text(&title.text)
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::Caption;

    #[test]
    fn word_by_word_captions_light_each_word_in_turn() {
        use crate::project::{Caption, Word};
        let mut project = Project::new("Words");
        let word = |text: &str, start: f64, end: f64| Word {
            text: text.into(),
            start,
            end,
        };
        project.captions = vec![Caption {
            id: "a".into(),
            start: 1.0,
            end: 3.0,
            text: "Hi there".into(),
            words: vec![word("Hi", 1.5, 1.8), word("there", 2.0, 2.5)],
            clip: None,
        }];
        assert!(
            super::ass(&project)
                .contains("Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hi there\n"),
            "plain unless asked"
        );
        project.caption_words = true;
        let ass = super::ass(&project);
        assert!(
            ass.contains("Dialogue: 0,0:00:01.00,0:00:01.50,Default,,0,0,0,,Hi there\n"),
            "{ass}"
        );
        assert!(ass.contains("Dialogue: 0,0:00:01.50,0:00:02.00,Default,,0,0,0,,{\\c&H00D4FF&}Hi{\\c&HFFFFFF&} there\n"), "{ass}");
        assert!(ass.contains("Dialogue: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,Hi {\\c&H00D4FF&}there{\\c&HFFFFFF&}\n"), "{ass}");
    }

    #[test]
    fn ass_holds_each_caption_with_its_times() {
        let mut project = Project::new("Captions");
        project.add_captions(
            0.0,
            100.0,
            vec![
                Caption {
                    id: "a".into(),
                    start: 1.5,
                    end: 2.756,
                    text: "Hello {there}".into(),
                    words: Vec::new(),
                    clip: None,
                },
                Caption {
                    id: "b".into(),
                    start: 3725.0,
                    end: 3726.0,
                    text: "an hour in".into(),
                    words: Vec::new(),
                    clip: None,
                },
            ],
        );
        let ass = ass(&project);
        assert!(ass.contains("PlayResX: 1920\nPlayResY: 1080"));
        assert!(ass.contains("Style: Default,Nunito ExtraLight,82,"));
        assert!(
            ass.contains(",2,134,134,86,1\n"),
            "captions sit 8 % up from the bottom"
        );
        assert!(ass.contains("Dialogue: 0,0:00:01.50,0:00:02.76,Default,,0,0,0,,Hello (there)\n"));
        assert!(ass.contains("Dialogue: 0,1:02:05.00,1:02:06.00,Default,,0,0,0,,an hour in\n"));
        let id = project.add_title(2.0);
        project.title_mut(&id).unwrap().y = 0.25;
        assert!(super::ass(&project).contains("Dialogue: 1,0:00:02.00,0:00:05.00,Title,,0,0,0,,{\\pos(960,270)\\fs135\\bord8.7}Your title\n"));
    }
}
