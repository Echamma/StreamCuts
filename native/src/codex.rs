//! Codex, the editor: StreamCuts describes the project (its tracks and clips, titles, what's said when) and passes on
//! what the person asks; Codex answers with a reply and an edit plan in a fixed shape (see `schema`), which
//! `autoedit` carries out. It runs as the Codex CLI the person is signed in to (`codex exec`), read-only, with its
//! conversation resumed for each message so it remembers what was said and done.

use crate::project::{Project, TrackKind, Transition};
use crate::speech::{self, Spoken};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

pub const DEFAULT_MODEL: &str = "gpt-6-sol";

/// What Codex answers.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
pub struct Plan {
    pub reply: String,
    #[serde(default)]
    pub operations: Vec<Op>,
    /// The transition StreamCuts puts on every cut of the main video that has none and nothing playing over it.
    #[serde(default)]
    pub transition_for_bare_cuts: Option<BareCuts>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct BareCuts {
    pub style: String,
    pub seconds: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Cut,
    Remove,
    Move,
    Gif,
    Picture,
    StockVideo,
    Sound,
    Transition,
    Title,
    Volume,
    Speed,
    Zoom,
    Captions,
    Marker,
}

pub const KINDS: [&str; 14] = [
    "cut", "remove", "move", "gif", "picture", "stock_video", "sound", "transition", "title", "volume", "speed", "zoom",
    "captions", "marker",
];

/// One edit. Every field is there in every operation (the answer's shape is fixed); the ones an edit doesn't use are
/// null.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Op {
    pub kind: Kind,
    pub clip: Option<String>,
    pub start: Option<f64>,
    pub end: Option<f64>,
    pub query: Option<String>,
    pub text: Option<String>,
    pub style: Option<String>,
    pub x: Option<f32>,
    pub y: Option<f32>,
    pub size: Option<f32>,
    pub value: Option<f64>,
    pub sticker: Option<bool>,
}

/// The JSON Schema Codex's answer must fit.
pub fn schema() -> serde_json::Value {
    let number = serde_json::json!({"type": ["number", "null"]});
    let string = serde_json::json!({"type": ["string", "null"]});
    let styles: Vec<String> = Transition::ALL.iter().map(|t| t.key()).collect();
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["reply", "operations", "transition_for_bare_cuts"],
        "properties": {
            "reply": {"type": "string"},
            "transition_for_bare_cuts": {
                "type": ["object", "null"],
                "additionalProperties": false,
                "required": ["style", "seconds"],
                "properties": {"style": {"type": "string", "enum": styles}, "seconds": {"type": "number"}}
            },
            "operations": {"type": "array", "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["kind", "clip", "start", "end", "query", "text", "style", "x", "y", "size", "value", "sticker"],
                "properties": {
                    "kind": {"type": "string", "enum": KINDS},
                    "clip": string, "start": number, "end": number, "query": string, "text": string, "style": string,
                    "x": number, "y": number, "size": number, "value": number,
                    "sticker": {"type": ["boolean", "null"]}
                }
            }}
        }
    })
}

/// The schema for finding shorts in a long video.
pub fn shorts_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["shorts"],
        "properties": {"shorts": {"type": "array", "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["startSeconds", "endSeconds", "title", "description"],
            "properties": {
                "startSeconds": {"type": "number"}, "endSeconds": {"type": "number"},
                "title": {"type": "string"}, "description": {"type": "string"}
            }
        }}}
    })
}

fn clock(t: f64) -> String {
    format!("{:.2}", t.max(0.0))
}

/// The project as Codex reads it: its tracks top first with every clip, the titles, captions and markers, and what's
/// said when, all in timeline seconds.
pub fn describe(project: &Project, words: &[Spoken], sounds: &[String]) -> String {
    let mut out = String::new();
    let w = &mut out;
    let _ = writeln!(w, "# The project now");
    let _ = writeln!(
        w,
        "\"{}\": {}x{} at {} fps, {} s long.",
        project.name,
        project.width,
        project.height,
        project.fps,
        clock(project.duration())
    );
    let _ = writeln!(w, "\n## Tracks, top (in front) first");
    for (index, track) in project.tracks.iter().enumerate() {
        let kind = if track.kind == TrackKind::Video { "video" } else { "audio" };
        let mut flags = Vec::new();
        if track.locked {
            flags.push("locked: leave it alone");
        }
        if track.muted {
            flags.push("muted");
        }
        if track.hidden {
            flags.push("hidden");
        }
        let _ = writeln!(
            w,
            "Track {} \"{}\" ({kind}){}: {} clips",
            index + 1,
            track.name,
            if flags.is_empty() { String::new() } else { format!(", {}", flags.join(", ")) },
            track.clips.len()
        );
        for clip in &track.clips {
            let Some(media) = project.media(&clip.media_id) else { continue };
            let mut extra = Vec::new();
            if (clip.speed - 1.0).abs() > 1e-6 {
                extra.push(format!("speed {:.2}", clip.speed));
            }
            if (clip.volume - 1.0).abs() > 1e-3 {
                extra.push(format!("volume {:.2}", clip.volume));
            }
            if let Some((_, d)) = project.crossfade_before(&clip.id) {
                extra.push(format!("comes in with {} {:.2} s", clip.transition.key(), d));
            }
            if !clip.place.is_full() {
                extra.push(format!("placed at x {:.2} y {:.2} size {:.2}", clip.place.x, clip.place.y, clip.place.scale));
            }
            let _ = writeln!(
                w,
                "- clip {} \"{}\" {}-{} (source {}-{}){}",
                clip.id,
                media.name,
                clock(clip.start),
                clock(clip.end()),
                clock(clip.source_in),
                clock(clip.source_in + clip.source_length()),
                if extra.is_empty() { String::new() } else { format!(", {}", extra.join(", ")) }
            );
        }
    }
    if !project.titles.is_empty() {
        let _ = writeln!(w, "\n## Titles");
        for t in &project.titles {
            let _ = writeln!(w, "- title {} \"{}\" {}-{} at x {:.2} y {:.2} size {:.3}", t.id, t.text, clock(t.start), clock(t.end), t.x, t.y, t.size);
        }
    }
    let _ = writeln!(
        w,
        "\n## Captions\n{}",
        if project.captions.is_empty() { "None.".to_string() } else { format!("{} caption lines are on.", project.captions.len()) }
    );
    if !project.markers.is_empty() {
        let _ = writeln!(w, "\n## Markers");
        for m in &project.markers {
            let _ = writeln!(w, "- {} {}", clock(m.t), m.label);
        }
    }
    let _ = writeln!(w, "\n## What's said (timeline seconds)");
    if words.is_empty() {
        let _ = writeln!(w, "Nothing transcribed.");
    }
    for (start, end, text) in speech::lines(words) {
        let _ = writeln!(w, "[{}-{}] {}", clock(start), clock(end), text.trim());
    }
    let _ = writeln!(w, "\n## Sounds in the person's sound folder");
    if sounds.is_empty() {
        let _ = writeln!(w, "None (sounds come from Freesound, if there's a key).");
    } else {
        let _ = writeln!(w, "{}", sounds.join("\n"));
    }
    out
}

use std::fmt::Write as _;

/// What every request starts with: who Codex is here and how to answer.
pub fn instructions(services: &str) -> String {
    let styles: Vec<String> = Transition::ALL.iter().map(|t| format!("{} ({})", t.key(), t.label())).collect();
    format!(
        r#"You are the video editor inside StreamCuts, a video editing app. The person talks to you about their video and you edit it by answering with operations, which StreamCuts carries out at once (one undo step). You can't change files yourself and don't need to: everything you need is in this message, and nothing on disk needs reading.

Answer in the given JSON shape: "reply" (what you did, or the answer to a question, in a few plain sentences to the person), "operations" (the edits, in any order; [] when nothing should change), and "transition_for_bare_cuts".

# How StreamCuts carries out your operations
- All times are timeline seconds of the project as described below, before any of your operations. StreamCuts does every other operation first and the cuts last, from the latest back, so your times stay right.
- Every operation has every field; set the ones it uses and null the rest.
- After your operations, every cut on the main video track (two clips meeting) that has no transition and nothing playing above it gets "transition_for_bare_cuts" (a style and seconds, 0.2-1.0), unless that is null. Use it whenever you edit the video; null only when the person says they want no transitions.

# Operations
- cut: start, end. Takes that stretch out of the whole timeline (every track that isn't locked); what comes after moves up. Cut on the pauses between words, never through a word: use the word times. Use it for dead air, false starts, repeats and boring stretches.
- remove: clip (an id from the lists, a clip or a title). Deletes it.
- move: clip, start. Moves a clip or title so it starts there.
- gif: query (2-4 words for GIPHY), sticker (true: a cut-out sticker with no background; false: a rectangular GIF), start, end, x, y, size. Plays it over the video from start to end (it loops).
- picture: query (for Pixabay photos and illustrations), start, end, x, y, size. A still over the video.
- stock_video: query (for Pixabay videos), start, end, x, y, size. Silent stock footage over the video (size 1 fills the frame: a cutaway).
- sound: query (words for Freesound, or the exact name of a file from the person's sound folder), start, end (optional: where it must stop), value (volume, 0.1-1.5; 0.6 is a good start). A sound effect on its own audio track.
- transition: start (the time of a cut: where two clips meet on a video track), style, value (seconds, 0.2-1.5). How the cut's second clip comes in; it needs footage left over past the first clip's end, and StreamCuts says when there isn't.
- title: text, start, end, x, y, size (text height as a part of the frame's height, 0.04-0.15). On-screen text.
- volume: clip, value (1 is as recorded, 0 silent, up to 3).
- speed: clip, value (0.1-10). Everything after it moves to make room or close up.
- zoom: start, end, value (1.1-2: how far in), x, y (what stays in the middle). A punch-in on the main video for that stretch.
- captions: start, end (null for the whole video). Puts the words said on screen as captions.
- marker: start, text.
- x and y are where the middle of the thing goes, from the frame's left/top (0) to its right/bottom (1); size is its width as a part of the frame's width (0.2-0.45 suits most GIFs and pictures). Keep them off whatever the video is about and off each other.

# Taste
- Make it feel edited by someone good: tight, funny where the person is being funny, clear where they explain. Add things where they help (a reaction GIF on a punchline, a sound effect on an impact, a picture of what's being talked about, a title for a new part), not everywhere: a GIF or picture lasts 1-4 seconds; a sound effect is short.
- Transitions styles: {styles}.
- {services}
- If the person asks something, answer it; if they ask for a change, make just that change. If something can't be done, say so in the reply."#,
        styles = styles.join(", ")
    )
}

/// Where the Codex CLI is: `STREAMCUTS_CODEX` (codex.js or an executable), else the npm install's codex.js next to
/// `codex.cmd` on PATH (run with Node), else `codex` as a command.
fn codex_command() -> std::process::Command {
    let js = std::env::var_os("STREAMCUTS_CODEX").map(PathBuf::from).or_else(|| {
        std::env::var_os("PATH").and_then(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join("node_modules").join("@openai").join("codex").join("bin").join("codex.js"))
                .find(|p| p.is_file())
        })
    });
    match js {
        Some(js) if js.extension().is_some_and(|e| e == "js") => {
            let node = js
                .ancestors()
                .nth(5)
                .map(|npm| npm.join("node.exe"))
                .filter(|n| n.is_file())
                .unwrap_or_else(|| PathBuf::from("node"));
            let mut command = crate::ffmpeg::command(&node);
            command.arg(js);
            command
        }
        Some(exe) => crate::ffmpeg::command(&exe),
        None => crate::ffmpeg::command(Path::new("codex")),
    }
}

/// A running Codex request that can be stopped from another thread.
#[derive(Clone, Default)]
pub struct Stopper(Arc<Mutex<Option<u32>>>);

impl Stopper {
    /// Ends the request (and what it started).
    pub fn stop(&self) {
        if let Some(pid) = self.0.lock().ok().and_then(|mut p| p.take()) {
            let _ = crate::ffmpeg::command(Path::new("taskkill"))
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output();
        }
    }
}

/// Asks Codex, starting a conversation or carrying on `thread`, with the answer held to `schema`. `dir` is where it
/// runs (its own folder, so nothing nearby gets read in). Returns the conversation's id and the answer's text. Blocking:
/// run it off the UI thread.
pub fn ask(
    prompt: &str,
    thread: Option<&str>,
    model: &str,
    dir: &Path,
    schema: &serde_json::Value,
    progress: &dyn Fn(String),
    stopper: &Stopper,
) -> Result<(Option<String>, String), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let schema_path = dir.join("schema.json");
    std::fs::write(&schema_path, serde_json::to_vec_pretty(schema).unwrap()).map_err(|e| e.to_string())?;
    let answer = dir.join(format!("answer-{}.json", crate::project::new_id()));
    let mut command = codex_command();
    command.arg("exec");
    if thread.is_some() {
        command.arg("resume");
    }
    command
        .args(["--skip-git-repo-check", "--json", "-m", model, "-c", "sandbox_mode=\"read-only\""])
        .arg("--output-schema")
        .arg(&schema_path)
        .arg("-o")
        .arg(&answer);
    match thread {
        Some(thread) => {
            command.arg(thread);
        }
        None => {
            command.arg("-C").arg(dir);
        }
    }
    command.arg("-").current_dir(dir);
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Codex couldn't start ({e}). Install the Codex CLI (npm i -g @openai/codex) and sign in."))?;
    if let Ok(mut pid) = stopper.0.lock() {
        *pid = Some(child.id());
    }
    child.stdin.take().unwrap().write_all(prompt.as_bytes()).map_err(|e| e.to_string())?;
    let stderr = child.stderr.take().unwrap();
    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = std::io::Read::read_to_string(&mut BufReader::new(stderr), &mut text);
        text
    });
    let mut started = thread.map(str::to_owned);
    let mut failure = None;
    for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
        let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        match event["type"].as_str().unwrap_or("") {
            "thread.started" => started = event["thread_id"].as_str().map(str::to_owned).or(started),
            "turn.started" => progress("Codex is thinking".into()),
            "item.started" | "item.completed" => match event["item"]["type"].as_str().unwrap_or("") {
                "reasoning" => progress("Codex is thinking".into()),
                "command_execution" => progress("Codex is looking something up".into()),
                "agent_message" => progress("Codex is writing its answer".into()),
                _ => {}
            },
            "turn.failed" | "error" => {
                let message = event["error"]["message"].as_str().or(event["message"].as_str()).unwrap_or("Codex failed.");
                // The error may itself be JSON from the server.
                let inner = serde_json::from_str::<serde_json::Value>(message)
                    .ok()
                    .and_then(|v| v["error"]["message"].as_str().map(str::to_owned));
                failure = Some(inner.unwrap_or_else(|| message.to_owned()));
            }
            _ => {}
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let stopped = stopper.0.lock().map(|p| p.is_none()).unwrap_or(false);
    if let Ok(mut pid) = stopper.0.lock() {
        *pid = None;
    }
    let errors = errors.join().unwrap_or_default();
    let text = std::fs::read_to_string(&answer).ok();
    let _ = std::fs::remove_file(&answer);
    match text.filter(|t| !t.trim().is_empty()) {
        Some(text) if status.success() => Ok((started, text)),
        _ if stopped => Err("Stopped.".into()),
        _ => Err(failure.unwrap_or_else(|| {
            let last = errors
                .lines()
                .filter(|l| !l.trim().is_empty() && !l.contains("failed to load skill"))
                .last()
                .unwrap_or("no details")
                .to_owned();
            format!("Codex failed: {last}")
        })),
    }
}

/// The models the Codex CLI offers this person (from its cache), best first; the default when there's no list.
pub fn models() -> Vec<String> {
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join(".codex")));
    let list: Vec<String> = home
        .and_then(|h| std::fs::read(h.join("models_cache.json")).ok())
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| {
            v["models"].as_array().map(|models| {
                models
                    .iter()
                    .filter(|m| m["visibility"].as_str() == Some("list"))
                    .filter_map(|m| m["slug"].as_str().map(str::to_owned))
                    .collect()
            })
        })
        .unwrap_or_default();
    if list.is_empty() { vec![DEFAULT_MODEL.to_owned()] } else { list }
}

/// Reads Codex's answer, forgiving a fenced block around it.
pub fn parse<T: for<'de> Deserialize<'de>>(text: &str) -> Result<T, String> {
    let text = text.trim();
    let text = text
        .strip_prefix("```json")
        .or_else(|| text.strip_prefix("```"))
        .map(|t| t.trim_end_matches("```").trim())
        .unwrap_or(text);
    serde_json::from_str(text).map_err(|e| format!("Codex answered in a shape StreamCuts can't read ({e})."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plan_reads_with_its_nulls() {
        let text = r#"{"reply":"Added a boom.","transition_for_bare_cuts":{"style":"wipe-left","seconds":0.4},
            "operations":[{"kind":"sound","clip":null,"start":3.5,"end":null,"query":"vine boom","text":null,"style":null,
            "x":null,"y":null,"size":null,"value":0.7,"sticker":null}]}"#;
        let plan: Plan = parse(text).unwrap();
        assert_eq!(plan.operations[0].kind, Kind::Sound);
        assert_eq!(plan.operations[0].query.as_deref(), Some("vine boom"));
        assert_eq!(plan.transition_for_bare_cuts.unwrap().style, "wipe-left");
        assert!(parse::<Plan>(&format!("```json\n{text}\n```")).is_ok());
        assert!(parse::<Plan>("nope").unwrap_err().contains("shape"));
    }

    #[test]
    fn the_schema_lists_every_kind_and_style() {
        let schema = schema();
        let kinds = &schema["properties"]["operations"]["items"]["properties"]["kind"]["enum"];
        assert_eq!(kinds.as_array().unwrap().len(), KINDS.len());
        for kind in KINDS {
            let parsed: Kind = serde_json::from_value(serde_json::json!(kind)).unwrap();
            assert_eq!(serde_json::to_value(parsed).unwrap(), kind);
        }
        let styles = &schema["properties"]["transition_for_bare_cuts"]["properties"]["style"]["enum"];
        assert!(styles.as_array().unwrap().iter().any(|s| s == "dip-to-black"));
    }

    #[test]
    fn the_project_is_described_with_its_clips_and_words() {
        use crate::project::{Attributes, Media, MediaKind};
        let mut project = Project::new("Ep 1");
        let media = project.add_media(Media {
            id: "m".into(),
            path: "C:/v.mp4".into(),
            name: "v.mp4".into(),
            kind: MediaKind::Video,
            duration: 10.0,
            width: 1920,
            height: 1080,
            has_audio: true,
            frame_rate: 30.0,
            attributes: Attributes::default(),
        });
        let clip = project.place(&media, Some(0), 0.0).unwrap();
        let words = vec![
            Spoken { start: 1.0, end: 1.4, text: "hello".into() },
            Spoken { start: 1.5, end: 1.9, text: "there".into() },
            Spoken { start: 4.0, end: 4.5, text: "later".into() },
        ];
        let text = describe(&project, &words, &["boom.mp3".into()]);
        assert!(text.contains(&format!("- clip {clip} \"v.mp4\" 0.00-10.00 (source 0.00-10.00)")), "{text}");
        assert!(text.contains("[1.00-1.90] hello there\n[4.00-4.50] later"), "{text}");
        assert!(text.contains("boom.mp3"));
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// Asks the real Codex CLI (signed in), then carries on the conversation. Run with --ignored.
    #[test]
    #[ignore]
    fn codex_answers_and_remembers() {
        let dir = std::env::temp_dir().join(format!("streamcuts-codex-{}", crate::project::new_id()));
        let stopper = Stopper::default();
        let said = std::sync::Mutex::new(Vec::new());
        let progress = |s: String| said.lock().unwrap().push(s);
        let prompt = format!(
            "{}\n\nThe video: one clip, 0-10 s. At 4.2-4.9 the person says \"boom\".\n\nThe person asks: add a fitting sound effect when they say boom, nothing else.",
            instructions("Sounds come from Freesound.")
        );
        let (thread, text) = ask(&prompt, None, DEFAULT_MODEL, &dir, &schema(), &progress, &stopper).unwrap();
        let plan: Plan = parse(&text).unwrap();
        println!("{plan:#?}");
        assert!(thread.is_some());
        assert!(plan.operations.iter().any(|o| o.kind == Kind::Sound), "{plan:?}");
        let (again, text) = ask("The project now has your sound as clip s1 on an audio track, 4.20-4.90. Make that sound quieter, at volume 0.3. Only that change.", thread.as_deref(), DEFAULT_MODEL, &dir, &schema(), &progress, &stopper).unwrap();
        let plan: Plan = parse(&text).unwrap();
        println!("{plan:#?}\n{:?}", said.lock().unwrap());
        assert_eq!(again, thread);
        assert!(plan.operations.iter().any(|o| o.kind == Kind::Volume && o.clip.as_deref() == Some("s1") && o.value == Some(0.3)), "{plan:?}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
