//! Projects are `.streamcuts.json` files in the projects folder (a space's `StreamCuts\`, or Documents on its own),
//! named after the project with a short id so two projects can share a name.

use crate::project::Project;
use canopy_ui::Document;
use canopy_ui::canopy_core::files::{safe_file_name, write_atomic};
use canopy_ui::canopy_core::now_ms;
use std::fs;
use std::path::{Path, PathBuf};

pub const EXTENSION: &str = ".streamcuts.json";

fn project_files(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.to_string_lossy().ends_with(EXTENSION))
                .collect()
        })
        .unwrap_or_default()
}

pub fn load(path: &Path) -> Result<Project, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "This isn't a StreamCuts project.".to_string())
}

/// The file a project is saved in: the one already holding its id, else a new name.
pub fn file_for(dir: &Path, project: &Project) -> PathBuf {
    project_files(dir)
        .into_iter()
        .find(|path| load(path).map(|p| p.id == project.id).unwrap_or(false))
        .unwrap_or_else(|| {
            dir.join(format!(
                "{}--{}{EXTENSION}",
                safe_file_name(&project.name),
                &project.id[..8]
            ))
        })
}

pub fn save(dir: &Path, project: &mut Project) -> Result<PathBuf, String> {
    project.saved_at = now_ms();
    let path = file_for(dir, project);
    let json = serde_json::to_vec_pretty(project).map_err(|e| e.to_string())?;
    write_atomic(&path, &json).map_err(|e| e.to_string())?;
    Ok(path)
}

fn clock(seconds: f64) -> String {
    let s = seconds.round() as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

/// The projects in a folder, newest first, for Canopy's sidebar and the projects list.
pub fn list(dir: &Path) -> Vec<Document> {
    let mut documents: Vec<Document> = project_files(dir)
        .into_iter()
        .filter_map(|path| {
            let project = load(&path).ok()?;
            let clips: usize = project.tracks.iter().map(|t| t.clips.len()).sum();
            Some(Document {
                id: path.file_name()?.to_string_lossy().into_owned(),
                name: project.name.clone(),
                saved_at: project.saved_at,
                detail: format!(
                    "{clips} clip{} · {}",
                    if clips == 1 { "" } else { "s" },
                    clock(project.duration())
                ),
            })
        })
        .collect();
    documents.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    documents
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_project_keeps_its_file_when_renamed() {
        let dir = std::env::temp_dir().join(format!("streamcuts-storage-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let mut project = Project::new("Trailer");
        let first = save(&dir, &mut project).unwrap();
        project.name = "Final trailer".into();
        assert_eq!(save(&dir, &mut project).unwrap(), first);
        let listed = list(&dir);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Final trailer");
        assert_eq!(load(&dir.join(&listed[0].id)).unwrap().id, project.id);
        fs::remove_dir_all(dir).unwrap();
    }
}
