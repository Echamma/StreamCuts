//! Captions from speech. The clip's sound is cut out with FFmpeg (so a 30-second clip of a 12-hour stream transcribes
//! 30 seconds) and read by the faster-whisper script StreamCuts' web backend uses,
//! `backend/long-to-short/python/transcribe.py`, which prints segments with word timings as JSON.

use crate::ffmpeg;
use crate::project::{Caption, Word, new_id};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;

const SCRIPT: &str = "backend/long-to-short/python/transcribe.py";

#[derive(Deserialize)]
struct Transcript {
    #[serde(default)]
    segments: Vec<Segment>,
}

#[derive(Deserialize)]
struct Segment {
    start: f64,
    end: f64,
    text: String,
    #[serde(default)]
    words: Vec<SpokenWord>,
}

#[derive(Deserialize)]
struct SpokenWord {
    word: String,
    start: f64,
    end: f64,
}

/// `STREAMCUTS_TRANSCRIBE`, else the script in the StreamCuts checkout this binary was built in or ships with.
pub fn script() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("STREAMCUTS_TRANSCRIBE").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(path);
    }
    let exe = std::env::current_exe().ok()?;
    exe.ancestors().skip(1).map(|dir| dir.join(SCRIPT)).find(|path| path.is_file())
}

/// `STREAMCUTS_PYTHON`, else `python` on PATH.
pub fn python() -> PathBuf {
    std::env::var_os("STREAMCUTS_PYTHON").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("python"))
}

/// Captions for `length` seconds of `media` from source time `from`, played at `speed` on the timeline from `at`.
/// Blocking and slow (the speech model loads first): run it on a thread of its own.
pub fn captions(media: &Path, from: f64, length: f64, speed: f64, at: f64) -> Result<Vec<Caption>, String> {
    let script = script().ok_or("Captions need StreamCuts' transcription script (set STREAMCUTS_TRANSCRIBE to transcribe.py).")?;
    let dir = std::env::temp_dir().join(format!("streamcuts-captions-{}", new_id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let result = transcribe_in(&dir, &script, media, from, length);
    let _ = std::fs::remove_dir_all(&dir);
    Ok(place(result?, at, length, speed))
}

fn transcribe_in(dir: &Path, script: &Path, media: &Path, from: f64, length: f64) -> Result<Transcript, String> {
    let sound = dir.join("sound.wav");
    let cut = ffmpeg::command(&ffmpeg::ffmpeg())
        .args(["-v", "error", "-y", "-ss", &format!("{from:.3}")])
        .arg("-i")
        .arg(media)
        .args(["-t", &format!("{length:.3}"), "-vn", "-ac", "1", "-ar", "16000"])
        .arg(&sound)
        .output()
        .map_err(|e| format!("FFmpeg couldn't start ({e})."))?;
    if !cut.status.success() || !sound.is_file() {
        return Err("This clip has no sound to caption.".into());
    }
    let output = ffmpeg::command(&python())
        .arg(script)
        .arg("--input")
        .arg(&sound)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Python couldn't start ({e}). Install Python with faster-whisper, or set STREAMCUTS_PYTHON."))?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Transcription failed: {}", error.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("no details")));
    }
    serde_json::from_slice(&output.stdout).map_err(|e| format!("Transcription said something unexpected ({e})."))
}

/// Turns segments timed from the start of the cut-out sound (source seconds) into captions on the timeline.
fn place(transcript: Transcript, at: f64, length: f64, speed: f64) -> Vec<Caption> {
    let timeline = |t: f64| at + t.clamp(0.0, length) / speed;
    transcript
        .segments
        .into_iter()
        .filter(|segment| !segment.text.trim().is_empty() && segment.start < length)
        .map(|segment| Caption {
            id: new_id(),
            start: timeline(segment.start),
            end: timeline(segment.end.max(segment.start)),
            text: segment.text.trim().to_owned(),
            words: segment.words.into_iter().map(|w| Word { text: w.word, start: timeline(w.start), end: timeline(w.end) }).collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_land_where_the_clip_is_on_the_timeline() {
        let json = r#"{"text":"hi there. bye","segments":[
            {"text":" hi there.","start":0.5,"end":1.75,"words":[{"word":"hi","start":0.5,"end":0.9},{"word":"there.","start":1.0,"end":1.75}]},
            {"text":"  ","start":2.0,"end":2.5},
            {"text":"bye","start":3.0,"end":9.0}]}"#;
        let captions = place(serde_json::from_str(json).unwrap(), 10.0, 4.0, 1.0);
        assert_eq!(captions.len(), 2, "blank segments are dropped");
        assert_eq!((captions[0].start, captions[0].end, captions[0].text.as_str()), (10.5, 11.75, "hi there."));
        assert_eq!((captions[0].words[1].start, captions[0].words[1].text.as_str()), (11.0, "there."));
        assert_eq!(captions[1].end, 14.0, "kept inside the clip");
        let fast = place(serde_json::from_str(json).unwrap(), 10.0, 4.0, 2.0);
        assert_eq!((fast[0].start, fast[1].end), (10.25, 12.0), "a clip at 2x says it all in half the time");
    }

    #[test]
    fn finds_the_script_in_the_checkout() {
        // Test binaries live in native/target/debug/deps, inside the StreamCuts checkout.
        assert!(script().is_some_and(|path| path.ends_with("transcribe.py")));
    }
}
