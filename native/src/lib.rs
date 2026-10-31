//! StreamCuts, native: a video editor that runs on its own (the `streamcuts` binary) or as a pane in Canopy.

pub mod app;
pub mod export;
pub mod ffmpeg;
pub mod preview;
pub mod project;
pub mod storage;
pub mod timeline;
pub mod worker;

use canopy_ui::{Accent, AppDescriptor, CanopyApp, Document, Place};

fn documents(place: &Place) -> Vec<Document> {
    storage::list(&place.projects_dir)
}

fn create(place: Place, ctx: &egui::Context) -> Box<dyn CanopyApp> {
    Box::new(app::StreamCuts::new(place, ctx))
}

pub static DESCRIPTOR: AppDescriptor = AppDescriptor {
    id: "streamcuts",
    name: "StreamCuts",
    description: "Edit videos and cut clips",
    accent: Accent::Berry,
    initial: "SC",
    folder: "StreamCuts",
    icon_png: include_bytes!("../assets/streamcuts.png"),
    accepts: app::accepts,
    documents,
    create,
};
