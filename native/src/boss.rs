//! A short found in a long video: where it is in the source, and what to call it. Codex finds them now (the Codex
//! panel's "Find shorts"); picking one opens it as a 9:16 project.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub title: String,
    #[serde(default)]
    pub description: String,
}
