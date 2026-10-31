// StreamCuts on its own: its window, its projects in Documents. Inside Canopy the same editor runs in a pane.
#![windows_subsystem = "windows"]

fn main() -> canopy_ui::eframe::Result {
    canopy_ui::run_standalone(&streamcuts::DESCRIPTOR)
}
