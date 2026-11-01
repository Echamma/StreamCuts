//! A cache of what's slow to work out from a media file (its waveform and filmstrip), kept in the app's data folder so
//! reopening a project with a 12-hour stream doesn't decode it all again. Entries are named after the file's path, size
//! and modification time, so an edited or replaced file gets new ones.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Where the `kind` entry for `media` lives in `dir`; `None` when the file can't be read.
pub fn entry(dir: &Path, media: &Path, kind: &str) -> Option<PathBuf> {
    let meta = std::fs::metadata(media).ok()?;
    let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis();
    let mut hasher = DefaultHasher::new();
    (media, meta.len(), modified).hash(&mut hasher);
    Some(dir.join("looks").join(format!("{:016x}.{kind}", hasher.finish())))
}

pub fn read(entry: &Path) -> Option<Vec<u8>> {
    std::fs::read(entry).ok().filter(|bytes| !bytes.is_empty())
}

/// Writes an entry, quietly: a cache that can't be written only costs time.
pub fn write(entry: &Path, bytes: &[u8]) {
    if let Some(dir) = entry.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let partial = entry.with_extension("partial");
    if std::fs::write(&partial, bytes).is_ok() {
        let _ = std::fs::rename(&partial, entry);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_changed_file_gets_a_new_entry() {
        let dir = std::env::temp_dir().join(format!("streamcuts-cache-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let media = dir.join("clip.bin");
        std::fs::write(&media, b"one").unwrap();
        let first = entry(&dir, &media, "wave").unwrap();
        write(&first, b"peaks");
        assert_eq!(read(&first).as_deref(), Some(&b"peaks"[..]));
        std::fs::write(&media, b"longer").unwrap();
        assert_ne!(entry(&dir, &media, "wave").unwrap(), first);
        assert!(entry(&dir, &dir.join("gone.bin"), "wave").is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
