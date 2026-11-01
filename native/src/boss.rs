//! Boss AI finds short moments in a long video. Transcription and HTTPS run off the UI thread.

use crate::ffmpeg;
use crate::transcribe;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::Path;
use std::process::Stdio;

const CHUNK: f64 = 600.0;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub title: String,
    #[serde(default)]
    pub description: String,
}

/// Finds up to three shorts in each ten-minute stretch, with source-relative timestamps.
pub fn suggest(path: &Path, duration: f64) -> Result<Vec<Suggestion>, String> {
    if duration <= 0.0 || !duration.is_finite() { return Err("This source has no usable duration.".into()); }
    let transcript = transcribe::source_transcript(path, duration)?;
    if transcript.is_empty() { return Err("No speech found in this video.".into()); }
    let mut suggestions = Vec::new();
    let mut from = 0.0;
    while from < duration {
        let end = (from + CHUNK).min(duration);
        let lines = transcript.iter().filter(|s| s.end > from && s.start < end)
            .map(|s| format!("[{:.1}-{:.1}] {}", s.start, s.end, s.text))
            .collect::<Vec<_>>();
        if !lines.is_empty() {
            let prompt = format!("Find up to three strong, self-contained shorts from this video stretch. Return absolute source timestamps between {from:.1} and {end:.1} seconds. Each short should be 15-90 seconds, with a punchy 3-5 word title and a short description. Return a JSON array only. Transcript:\n{}", lines.join("\n"));
            suggestions.extend(parse_plan(&generate(&prompt)?, from, end)?);
        }
        from = end;
    }
    suggestions.sort_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds));
    Ok(suggestions)
}

fn parse_plan(text: &str, from: f64, end: f64) -> Result<Vec<Suggestion>, String> {
    let raw: Vec<Suggestion> = serde_json::from_str(text).map_err(|e| format!("Boss AI returned an unreadable plan: {e}"))?;
    Ok(raw.into_iter().filter_map(|mut s| {
        if !s.start_seconds.is_finite() || !s.end_seconds.is_finite() { return None; }
        s.start_seconds = s.start_seconds.max(from);
        s.end_seconds = s.end_seconds.min(end);
        let length = s.end_seconds - s.start_seconds;
        if !(4.0..=92.0).contains(&length) || s.title.trim().is_empty() { return None; }
        s.title = s.title.trim().chars().take(60).collect();
        s.description = s.description.trim().chars().take(300).collect();
        Some(s)
    }).take(3).collect())
}

fn generate(prompt: &str) -> Result<String, String> {
    // A recorded response lets the editor be tested without an API key or network request.
    if let Some(file) = std::env::var_os("STREAMCUTS_BOSS_RESPONSE") {
        return std::fs::read_to_string(file).map_err(|e| format!("Couldn't read recorded Boss AI response: {e}"));
    }
    let key = std::env::var("GEMINI_API_KEY").map_err(|_| "Set GEMINI_API_KEY before using Boss AI.".to_owned())?;
    if key.contains(['\r', '\n', '"']) { return Err("GEMINI_API_KEY has invalid characters.".into()); }
    let model = std::env::var("GEMINI_MODEL").unwrap_or_else(|_| "gemini-3.5-flash".into());
    if !model.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
        return Err("GEMINI_MODEL has invalid characters.".into());
    }
    let url = format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent");
    let body = serde_json::json!({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
                "startSeconds": {"type": "NUMBER"}, "endSeconds": {"type": "NUMBER"},
                "title": {"type": "STRING"}, "description": {"type": "STRING"}
            }, "required": ["startSeconds", "endSeconds", "title", "description"]}}
        }
    });
    // curl's config and request body cannot both use stdin. Put the body in a temporary file, while the key goes
    // through stdin so it never appears in the process command line.
    let body_file = std::env::temp_dir().join(format!("streamcuts-boss-request-{}.json", crate::project::new_id()));
    std::fs::write(&body_file, body.to_string()).map_err(|e| e.to_string())?;
    let result = call_curl(&url, &key, &body_file);
    let _ = std::fs::remove_file(&body_file);
    result
}

fn call_curl(url: &str, key: &str, body_file: &Path) -> Result<String, String> {
    let mut child = ffmpeg::command(Path::new("curl.exe"))
        .args(["--silent", "--show-error", "--fail-with-body", "--max-time", "180", "--request", "POST", "--header", "Content-Type: application/json", "--data-binary"])
        .arg(format!("@{}", body_file.display()))
        .args(["--url", url, "--config", "-"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| format!("curl.exe couldn't start ({e})."))?;
    write!(child.stdin.take().unwrap(), "header = \"x-goog-api-key: {key}\"\n").map_err(|e| e.to_string())?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        let response = serde_json::from_slice::<serde_json::Value>(&output.stdout).ok();
        return Err(response.as_ref().and_then(|v| v["error"]["message"].as_str()).unwrap_or("Gemini request failed.").to_owned());
    }
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|e| format!("Gemini response wasn't JSON: {e}"))?;
    response["candidates"][0]["content"]["parts"][0]["text"].as_str()
        .map(str::to_owned).ok_or_else(|| "Gemini returned no plan.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;

    #[test]
    fn plans_are_clamped_to_the_source_chunk() {
        let plan = r#"[{"startSeconds":595,"endSeconds":615,"title":"A strong moment"},{"startSeconds":3,"endSeconds":9,"title":"outside"},{"startSeconds":599,"endSeconds":600,"title":"too short"}]"#;
        let items = parse_plan(plan, 590.0, 610.0).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!((items[0].start_seconds, items[0].end_seconds), (595.0, 610.0));
    }

    #[test]
    fn curl_sends_the_key_as_a_header_and_reads_a_structured_reply() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/generateContent", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            let mut buffer = [0; 8192];
            let count = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..count]).to_lowercase();
            assert!(request.contains("x-goog-api-key: test-key"));
            assert!(request.contains("post /generatecontent"));
            let reply = r#"{"candidates":[{"content":{"parts":[{"text":"[]"}]}}]}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len()).unwrap();
        });
        let body = std::env::temp_dir().join(format!("boss-curl-test-{}.json", crate::project::new_id()));
        std::fs::write(&body, "{}").unwrap();
        let result = call_curl(&url, "test-key", &body);
        let _ = std::fs::remove_file(&body);
        assert_eq!(result.unwrap(), "[]");
        server.join().unwrap();
    }
}
