//! Finding and downloading what Codex asks for: GIFs and stickers from GIPHY, pictures and stock video from Pixabay,
//! and sound effects from the person's own sound folder or Freesound. Requests go through Windows' curl.exe with the URL
//! (and so the key) on its standard input, never on its command line. Each download is kept in the project's assets
//! folder and reused when the same thing is asked for again.

use crate::ffmpeg;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;

/// The person's keys and sound folder, kept in the app's private data folder.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Keys {
    pub giphy: String,
    pub pixabay: String,
    pub freesound: String,
    pub sounds: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Want {
    Gif { sticker: bool },
    Picture,
    StockVideo,
    /// A sound effect (or music), at most about this long.
    Sound { longest: f64 },
}

/// A downloaded (or found) file, and who to credit for it.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub path: PathBuf,
    pub credit: String,
}

const AUDIO: [&str; 7] = ["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"];

/// Fetches what's wanted into `dir`, or finds it there (or in the sound folder) from before.
pub fn find(want: Want, query: &str, keys: &Keys, dir: &Path) -> Result<Found, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("Nothing to search for.".into());
    }
    let key = format!("{want:?}:{}", query.to_lowercase());
    let index_path = dir.join("index.json");
    let mut index: HashMap<String, (String, String)> = std::fs::read(&index_path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    if let Some((file, credit)) = index.get(&key) {
        let path = PathBuf::from(file);
        if path.is_file() {
            return Ok(Found { path, credit: credit.clone() });
        }
    }
    let found = match want {
        Want::Sound { longest } => match keys.sounds.as_deref().and_then(|folder| from_folder(folder, query)) {
            Some(path) => Found { credit: String::new(), path },
            None if !keys.freesound.trim().is_empty() => freesound(query, longest, &keys.freesound, dir)?,
            None if keys.sounds.is_some() => return Err(format!("No sound like \"{query}\" in your sound folder, and no Freesound key to look further.")),
            None => return Err("Add a sound folder or a Freesound key to get sounds.".into()),
        },
        Want::Gif { sticker } => giphy(query, sticker, &keys.giphy, dir)?,
        Want::Picture => pixabay_picture(query, &keys.pixabay, dir)?,
        Want::StockVideo => pixabay_video(query, &keys.pixabay, dir)?,
    };
    index.insert(key, (found.path.to_string_lossy().into_owned(), found.credit.clone()));
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(&index_path, serde_json::to_vec_pretty(&index).unwrap_or_default());
    Ok(found)
}

fn need(key: &str, service: &str) -> Result<(), String> {
    if key.trim().is_empty() {
        Err(format!("Add your {service} key in Codex's settings first."))
    } else {
        Ok(())
    }
}

fn giphy(query: &str, sticker: bool, key: &str, dir: &Path) -> Result<Found, String> {
    need(key, "GIPHY")?;
    let kind = if sticker { "stickers" } else { "gifs" };
    let url = format!(
        "https://api.giphy.com/v1/{kind}/search?api_key={}&q={}&limit=5&rating=pg-13&lang=en",
        encode(key.trim()),
        encode(&query.chars().take(50).collect::<String>())
    );
    let reply = get_json(&url, "GIPHY")?;
    let hit = reply["data"]
        .as_array()
        .and_then(|list| list.iter().find(|g| g["images"]["original"]["url"].is_string()))
        .ok_or_else(|| format!("GIPHY has no {} for \"{query}\".", if sticker { "sticker" } else { "GIF" }))?;
    let id = hit["id"].as_str().unwrap_or("gif");
    let path = dir.join(format!("giphy-{}.gif", safe(id)));
    download(hit["images"]["original"]["url"].as_str().unwrap(), &path)?;
    Ok(Found { path, credit: "GIPHY".into() })
}

fn pixabay_picture(query: &str, key: &str, dir: &Path) -> Result<Found, String> {
    need(key, "Pixabay")?;
    let url = format!(
        "https://pixabay.com/api/?key={}&q={}&image_type=all&safesearch=true&per_page=5",
        encode(key.trim()),
        encode(&query.chars().take(100).collect::<String>())
    );
    let reply = get_json(&url, "Pixabay")?;
    let hit = reply["hits"]
        .as_array()
        .and_then(|list| list.iter().find(|h| h["largeImageURL"].is_string()))
        .ok_or_else(|| format!("Pixabay has no picture for \"{query}\"."))?;
    let link = hit["largeImageURL"].as_str().unwrap();
    let extension = if link.to_lowercase().ends_with(".png") { "png" } else { "jpg" };
    let path = dir.join(format!("pixabay-{}.{extension}", hit["id"]));
    download(link, &path)?;
    Ok(Found { path, credit: format!("{} on Pixabay", hit["user"].as_str().unwrap_or("Pixabay")) })
}

fn pixabay_video(query: &str, key: &str, dir: &Path) -> Result<Found, String> {
    need(key, "Pixabay")?;
    let url = format!(
        "https://pixabay.com/api/videos/?key={}&q={}&safesearch=true&per_page=5",
        encode(key.trim()),
        encode(&query.chars().take(100).collect::<String>())
    );
    let reply = get_json(&url, "Pixabay")?;
    let pick = |h: &serde_json::Value| {
        ["medium", "small", "large", "tiny"]
            .iter()
            .find_map(|size| h["videos"][size]["url"].as_str().filter(|u| !u.is_empty()).map(str::to_owned))
    };
    let (hit, link) = reply["hits"]
        .as_array()
        .and_then(|list| list.iter().find_map(|h| pick(h).map(|l| (h, l))))
        .ok_or_else(|| format!("Pixabay has no video for \"{query}\"."))?;
    let path = dir.join(format!("pixabay-{}.mp4", hit["id"]));
    download(&link, &path)?;
    Ok(Found { path, credit: format!("{} on Pixabay", hit["user"].as_str().unwrap_or("Pixabay")) })
}

fn freesound(query: &str, longest: f64, key: &str, dir: &Path) -> Result<Found, String> {
    let filter = format!("duration:[0.1 TO {:.0}]", longest.clamp(2.0, 600.0).ceil());
    let url = format!(
        "https://freesound.org/apiv2/search/text/?query={}&filter={}&fields=id,name,username,license,previews&page_size=5&token={}",
        encode(&query.chars().take(100).collect::<String>()),
        encode(&filter),
        encode(key.trim())
    );
    let reply = get_json(&url, "Freesound")?;
    let hit = reply["results"]
        .as_array()
        .and_then(|list| list.iter().find(|r| r["previews"]["preview-hq-mp3"].is_string()))
        .ok_or_else(|| format!("Freesound has no sound for \"{query}\"."))?;
    let path = dir.join(format!("freesound-{}.mp3", hit["id"]));
    download(hit["previews"]["preview-hq-mp3"].as_str().unwrap(), &path)?;
    let license = hit["license"].as_str().unwrap_or("");
    let license = if license.contains("/zero/") {
        "CC0"
    } else if license.contains("/by-nc/") {
        "CC BY-NC"
    } else if license.contains("/by/") {
        "CC BY"
    } else {
        "Freesound license"
    };
    Ok(Found {
        path,
        credit: format!("\"{}\" by {} on Freesound ({license})", hit["name"].as_str().unwrap_or("sound"), hit["username"].as_str().unwrap_or("?")),
    })
}

/// The sound files in a folder (and the folders in it), for Codex to pick from by name.
pub fn sound_files(folder: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![(folder.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && depth < 4 {
                stack.push((path, depth + 1));
            } else if path
                .extension()
                .is_some_and(|e| AUDIO.contains(&e.to_string_lossy().to_lowercase().as_str()))
            {
                out.push(path);
            }
            if out.len() >= 2000 {
                return out;
            }
        }
    }
    out.sort();
    out
}

fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() >= 2)
        .map(str::to_owned)
        .collect()
}

/// The sound in the folder that best fits the query: its exact file name, else the most words in common.
fn from_folder(folder: &Path, query: &str) -> Option<PathBuf> {
    let files = sound_files(folder);
    let wanted = query.trim().to_lowercase();
    if let Some(exact) = files.iter().find(|p| {
        let name = p.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
        let stem = p.file_stem().unwrap_or_default().to_string_lossy().to_lowercase();
        name == wanted || stem == wanted
    }) {
        return Some(exact.clone());
    }
    let query_words = words(query);
    files
        .into_iter()
        .map(|p| {
            let name_words = words(&p.file_stem().unwrap_or_default().to_string_lossy());
            let score = query_words.iter().filter(|w| name_words.contains(w)).count();
            (score, std::cmp::Reverse(name_words.len()), p)
        })
        .filter(|(score, ..)| *score > 0)
        .max_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)))
        .map(|(.., p)| p)
}

fn safe(text: &str) -> String {
    text.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(40).collect()
}

/// Percent-encodes everything but letters, digits and `-_.~`.
pub fn encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Runs curl with `url` (and whatever else) given on its standard input as a config file.
fn curl(config: &str, out: Option<&Path>) -> Result<Vec<u8>, String> {
    let mut command = ffmpeg::command(Path::new("curl.exe"));
    command.args(["--silent", "--show-error", "--location", "--max-time", "120", "--max-filesize", "80000000"]);
    if let Some(out) = out {
        command.arg("--fail").arg("--output").arg(out);
    }
    let mut child = command
        .args(["--config", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("curl.exe couldn't start ({e})."))?;
    child.stdin.take().unwrap().write_all(config.as_bytes()).map_err(|e| e.to_string())?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        return Err(error.lines().last().unwrap_or("the download failed").trim().to_owned());
    }
    Ok(output.stdout)
}

fn config_url(url: &str) -> String {
    format!("url = \"{}\"\nuser-agent = \"StreamCuts\"\n", url.replace('\\', "\\\\").replace('"', "\\\""))
}

fn get_json(url: &str, service: &str) -> Result<serde_json::Value, String> {
    let body = curl(&(config_url(url) + "write-out = \"\\n%{http_code}\"\n"), None)?;
    let text = String::from_utf8_lossy(&body);
    let (json, status) = text.rsplit_once('\n').unwrap_or((&text, "200"));
    let status: u16 = status.trim().parse().unwrap_or(0);
    let value: serde_json::Value = serde_json::from_str(json).unwrap_or(serde_json::Value::Null);
    match status {
        200 => Ok(value),
        401 | 403 => Err(format!("{service} didn't accept your key.")),
        429 => Err(format!("{service} says too many requests for now; try again in a while.")),
        _ => Err(format!(
            "{service} answered {status}{}",
            value["message"].as_str().or(value["detail"].as_str()).map(|m| format!(": {m}")).unwrap_or_default()
        )),
    }
}

fn download(url: &str, path: &Path) -> Result<(), String> {
    if path.is_file() {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let partial = path.with_extension("part");
    curl(&config_url(url), Some(&partial)).map_err(|e| format!("The download failed: {e}"))?;
    std::fs::rename(&partial, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sounds_are_picked_from_the_folder_by_name() {
        let dir = std::env::temp_dir().join(format!("streamcuts-sounds-{}", crate::project::new_id()));
        std::fs::create_dir_all(dir.join("Memes")).unwrap();
        for name in ["Memes/vine boom.mp3", "air horn LOUD.wav", "boom - big explosion.ogg", "notes.txt"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        assert_eq!(sound_files(&dir).len(), 3);
        assert_eq!(from_folder(&dir, "vine boom.mp3").unwrap().file_name().unwrap(), "vine boom.mp3");
        assert_eq!(from_folder(&dir, "big explosion").unwrap().file_name().unwrap(), "boom - big explosion.ogg");
        assert_eq!(from_folder(&dir, "air horn").unwrap().file_name().unwrap(), "air horn LOUD.wav");
        assert!(from_folder(&dir, "sad violin").is_none());
        // Asked for again, the same file comes from the index; without keys or a folder, a clear message.
        let keys = Keys { sounds: Some(dir.clone()), ..Keys::default() };
        let first = find(Want::Sound { longest: 5.0 }, "Air horn", &keys, &dir.join("assets")).unwrap();
        assert_eq!(find(Want::Sound { longest: 5.0 }, "air horn", &keys, &dir.join("assets")).unwrap(), first);
        assert!(find(Want::Sound { longest: 5.0 }, "sad violin", &keys, &dir.join("assets")).unwrap_err().contains("sound folder"));
        assert!(find(Want::Gif { sticker: false }, "wow", &Keys::default(), &dir).unwrap_err().contains("GIPHY key"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A one-request web server on this computer that answers with `status` and `body`.
    fn serve(status: u16, body: &'static str) -> (String, std::thread::JoinHandle<String>) {
        use std::io::Read;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/thing?api_key=secret", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            let mut buffer = [0; 4096];
            let n = stream.read(&mut buffer).unwrap();
            write!(stream, "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            String::from_utf8_lossy(&buffer[..n]).into_owned()
        });
        (url, server)
    }

    #[test]
    fn answers_and_downloads_come_through_curl() {
        let (url, server) = serve(200, r#"{"data":[{"id":"abc"}]}"#);
        assert_eq!(get_json(&url, "GIPHY").unwrap()["data"][0]["id"], "abc");
        assert!(server.join().unwrap().starts_with("GET /thing?api_key=secret"));
        let (url, server) = serve(403, r#"{"message":"Invalid key"}"#);
        assert_eq!(get_json(&url, "Pixabay").unwrap_err(), "Pixabay didn't accept your key.");
        server.join().unwrap();
        let (url, server) = serve(200, "GIF89a");
        let dir = std::env::temp_dir().join(format!("streamcuts-download-{}", crate::project::new_id()));
        download(&url, &dir.join("a.gif")).unwrap();
        assert_eq!(std::fs::read(dir.join("a.gif")).unwrap(), b"GIF89a");
        server.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn queries_are_percent_encoded() {
        assert_eq!(encode("mind blown & \"wow\""), "mind%20blown%20%26%20%22wow%22");
        assert_eq!(encode("duration:[0.1 TO 5]"), "duration%3A%5B0.1%20TO%205%5D");
    }
}
