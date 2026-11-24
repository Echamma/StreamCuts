//! Every StreamCuts action as a named command: its group, its name and its keys. The keyboard, the Commands window
//! (F1, Ctrl+Shift+P or ?) and the shortcut list all read this one table, so nothing has a key the list doesn't show.
//!
//! Canopy takes Ctrl+Tab, Ctrl+1 to Ctrl+9, Ctrl+J, Ctrl+W, Ctrl+B, Ctrl+K and F11 before any app, so none are here.

use egui::{Event, InputState, Key, Modifiers};

/// A key with exactly these modifiers held (Ctrl means Cmd on a Mac).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Shortcut {
    pub key: Key,
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
}

const fn k(key: Key) -> Shortcut {
    Shortcut { key, ctrl: false, shift: false, alt: false }
}
const fn ctrl(key: Key) -> Shortcut {
    Shortcut { key, ctrl: true, shift: false, alt: false }
}
const fn shift(key: Key) -> Shortcut {
    Shortcut { key, ctrl: false, shift: true, alt: false }
}
const fn alt(key: Key) -> Shortcut {
    Shortcut { key, ctrl: false, shift: false, alt: true }
}
const fn ctrl_shift(key: Key) -> Shortcut {
    Shortcut { key, ctrl: true, shift: true, alt: false }
}
const fn alt_shift(key: Key) -> Shortcut {
    Shortcut { key, ctrl: false, shift: true, alt: true }
}
const fn ctrl_alt(key: Key) -> Shortcut {
    Shortcut { key, ctrl: true, shift: false, alt: true }
}

impl Shortcut {
    /// Takes this key press out of the frame's input if it's there, with exactly these modifiers.
    pub fn take(&self, input: &mut InputState) -> bool {
        let wanted = |m: &Modifiers| m.command == self.ctrl && m.shift == self.shift && m.alt == self.alt;
        let at = input.events.iter().position(|event| {
            matches!(event, Event::Key { key, pressed: true, modifiers, .. } if *key == self.key && wanted(modifiers))
        });
        match at {
            Some(at) => {
                input.events.remove(at);
                true
            }
            None => false,
        }
    }

    pub fn label(&self) -> String {
        let mut parts = Vec::new();
        if self.ctrl {
            parts.push("Ctrl");
        }
        if self.alt {
            parts.push("Alt");
        }
        if self.shift {
            parts.push("Shift");
        }
        let key = match self.key {
            Key::ArrowLeft => "â†",
            Key::ArrowRight => "â†’",
            Key::ArrowUp => "â†‘",
            Key::ArrowDown => "â†“",
            Key::OpenBracket => "[",
            Key::CloseBracket => "]",
            Key::Equals => "=",
            Key::Plus => "+",
            Key::Minus => "âˆ’",
            Key::Questionmark => "?",
            Key::Backspace => "Backspace",
            Key::PageUp => "Page Up",
            Key::PageDown => "Page Down",
            other => other.name(),
        };
        parts.push(key);
        parts.join("+")
    }
}

/// What a command does. Ones that act on clips use the selected clips (or the clip under the playhead where that
/// makes sense) and say so in a toast when there's nothing to act on.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Cmd {
    // Playback and moving around
    PlayPause,
    Seek(f64),
    Frame(bool),
    Cut(bool),
    Marker(bool),
    Start,
    End,
    AddMarker,
    RemoveMarker,
    Zoom(f32),
    ZoomFit,
    // Picking
    SelectAll,
    SelectNone,
    SelectAtPlayhead,
    SelectNeighbor { back: bool, extend: bool },
    SelectTrack(bool),
    // Editing
    Split,
    SplitAll,
    TrimToPlayhead(bool),
    Delete,
    RippleDelete,
    Copy,
    CutClips,
    Paste,
    Duplicate,
    Undo,
    Redo,
    Nudge(f64),
    NudgeFrames(i32),
    MoveTrack(bool),
    SlipFrames(i32),
    AddTitle,
    MakeCaptions,
    ClipMenu,
    // The selected clip
    ChangeSpeed,
    Fades,
    NoFades,
    Speed(f64),
    Volume(f32),
    FitOrFill,
    ResetPlace,
    GrabFrame,
    EditInFolio,
    EditFrameInFolio,
    ExportPart,
    ShowMore { before: bool, seconds: f64 },
    Ungroup,
    DetachSound,
    Unlink,
    MeasureLoudness,
    Normalize,
    Proxy,
    DeleteProxy,
    DetectScenes,
    AutoReframe,
    ResetColor,
    ResetEffects,
    // Tracks
    AddVideoTrack,
    AddAudioTrack,
    MuteTrack,
    HideTrack,
    LockTrack,
    Snap,
    // Media
    Import,
    MediaStep(bool),
    PlaceMedia,
    FindMedia,
    // Project and windows
    Projects,
    NewProject,
    Export,
    Queue,
    Shape(usize),
    EvenLoudness,
    NextFormat,
    Scopes,
    Boss,
    Commands,
}

pub struct Command {
    pub cmd: Cmd,
    pub group: &'static str,
    pub name: &'static str,
    pub keys: &'static [Shortcut],
}

const fn c(cmd: Cmd, group: &'static str, name: &'static str, keys: &'static [Shortcut]) -> Command {
    Command { cmd, group, name, keys }
}

const PLAY: &str = "Playback";
const PICK: &str = "Picking";
const EDIT: &str = "Editing";
const CLIP: &str = "Selected clip";
const TRACKS: &str = "Tracks";
const MEDIA: &str = "Media";
const PROJECT: &str = "Project";

pub const COMMANDS: &[Command] = &[
    c(Cmd::PlayPause, PLAY, "Play or pause", &[k(Key::Space), k(Key::K)]),
    c(Cmd::Seek(-1.0), PLAY, "Back a second", &[k(Key::J)]),
    c(Cmd::Seek(1.0), PLAY, "On a second", &[k(Key::L)]),
    c(Cmd::Seek(-5.0), PLAY, "Back 5 seconds", &[shift(Key::J)]),
    c(Cmd::Seek(5.0), PLAY, "On 5 seconds", &[shift(Key::L)]),
    c(Cmd::Frame(true), PLAY, "Back a frame", &[k(Key::ArrowLeft)]),
    c(Cmd::Frame(false), PLAY, "On a frame", &[k(Key::ArrowRight)]),
    c(Cmd::Cut(true), PLAY, "Go to the cut before", &[k(Key::ArrowUp)]),
    c(Cmd::Cut(false), PLAY, "Go to the cut after", &[k(Key::ArrowDown)]),
    c(Cmd::Marker(true), PLAY, "Go to the marker before", &[shift(Key::ArrowLeft)]),
    c(Cmd::Marker(false), PLAY, "Go to the marker after", &[shift(Key::ArrowRight)]),
    c(Cmd::Start, PLAY, "Go to the start", &[k(Key::Home)]),
    c(Cmd::End, PLAY, "Go to the end", &[k(Key::End)]),
    c(Cmd::AddMarker, PLAY, "Add a marker at the playhead", &[k(Key::M)]),
    c(Cmd::RemoveMarker, PLAY, "Remove the marker at the playhead", &[shift(Key::M)]),
    c(Cmd::Zoom(1.25), PLAY, "Zoom the timeline in", &[k(Key::Equals), shift(Key::Equals), k(Key::Plus), shift(Key::Plus)]),
    c(Cmd::Zoom(0.8), PLAY, "Zoom the timeline out", &[k(Key::Minus)]),
    c(Cmd::ZoomFit, PLAY, "Fit the whole timeline", &[k(Key::Z)]),
    c(Cmd::SelectAll, PICK, "Pick every clip", &[ctrl(Key::A)]),
    c(Cmd::SelectNone, PICK, "Pick nothing (or close a window)", &[k(Key::Escape)]),
    c(Cmd::SelectAtPlayhead, PICK, "Pick the clip under the playhead", &[k(Key::C)]),
    c(Cmd::SelectNeighbor { back: true, extend: false }, PICK, "Pick the clip before", &[k(Key::OpenBracket)]),
    c(Cmd::SelectNeighbor { back: false, extend: false }, PICK, "Pick the clip after", &[k(Key::CloseBracket)]),
    c(Cmd::SelectNeighbor { back: true, extend: true }, PICK, "Also pick the clip before", &[shift(Key::OpenBracket), shift(Key::OpenCurlyBracket), k(Key::OpenCurlyBracket)]),
    c(Cmd::SelectNeighbor { back: false, extend: true }, PICK, "Also pick the clip after", &[shift(Key::CloseBracket), shift(Key::CloseCurlyBracket), k(Key::CloseCurlyBracket)]),
    c(Cmd::SelectTrack(true), PICK, "Pick the clip on the track above", &[ctrl(Key::ArrowUp)]),
    c(Cmd::SelectTrack(false), PICK, "Pick the clip on the track below", &[ctrl(Key::ArrowDown)]),
    c(Cmd::Split, EDIT, "Split at the playhead", &[k(Key::S)]),
    c(Cmd::SplitAll, EDIT, "Split every track at the playhead", &[shift(Key::S)]),
    c(Cmd::TrimToPlayhead(true), EDIT, "Trim the start to the playhead", &[k(Key::Q)]),
    c(Cmd::TrimToPlayhead(false), EDIT, "Trim the end to the playhead", &[k(Key::W)]),
    c(Cmd::Delete, EDIT, "Delete (the picked file in Media when no clip is picked)", &[k(Key::Delete), k(Key::Backspace)]),
    c(Cmd::RippleDelete, EDIT, "Delete and close the gap", &[shift(Key::Delete), shift(Key::Backspace)]),
    c(Cmd::Copy, EDIT, "Copy", &[ctrl(Key::C)]),
    c(Cmd::CutClips, EDIT, "Cut", &[ctrl(Key::X)]),
    c(Cmd::Paste, EDIT, "Paste at the playhead", &[ctrl(Key::V)]),
    c(Cmd::Duplicate, EDIT, "Duplicate right after", &[ctrl(Key::D)]),
    c(Cmd::Undo, EDIT, "Undo", &[ctrl(Key::Z)]),
    c(Cmd::Redo, EDIT, "Redo", &[ctrl_shift(Key::Z), ctrl(Key::Y)]),
    c(Cmd::NudgeFrames(-1), EDIT, "Move the picked clips a frame earlier", &[alt(Key::ArrowLeft)]),
    c(Cmd::NudgeFrames(1), EDIT, "Move the picked clips a frame later", &[alt(Key::ArrowRight)]),
    c(Cmd::Nudge(-1.0), EDIT, "Move the picked clips a second earlier", &[alt_shift(Key::ArrowLeft)]),
    c(Cmd::Nudge(1.0), EDIT, "Move the picked clips a second later", &[alt_shift(Key::ArrowRight)]),
    c(Cmd::MoveTrack(true), EDIT, "Move the picked clips a track up", &[alt(Key::ArrowUp)]),
    c(Cmd::MoveTrack(false), EDIT, "Move the picked clips a track down", &[alt(Key::ArrowDown)]),
    c(Cmd::SlipFrames(-1), EDIT, "Slip: show the video a frame earlier", &[ctrl_alt(Key::ArrowLeft)]),
    c(Cmd::SlipFrames(1), EDIT, "Slip: show the video a frame later", &[ctrl_alt(Key::ArrowRight)]),
    c(Cmd::AddTitle, EDIT, "Add a title at the playhead", &[k(Key::T)]),
    c(Cmd::MakeCaptions, EDIT, "Make captions from speech", &[alt(Key::C)]),
    c(Cmd::ClipMenu, CLIP, "Open the Clip menu (Tab moves through it)", &[k(Key::Enter)]),
    c(Cmd::ChangeSpeed, CLIP, "Change clip speed… (speed or length, slow motion, pitch, ripple)", &[ctrl(Key::S)]),
    c(Cmd::Fades, CLIP, "Fade in and out (half a second)", &[k(Key::F)]),
    c(Cmd::NoFades, CLIP, "No fades", &[shift(Key::F)]),
    c(Cmd::Speed(0.25), CLIP, "Speed 0.25Ã—", &[]),
    c(Cmd::Speed(0.5), CLIP, "Speed 0.5Ã—", &[]),
    c(Cmd::Speed(1.0), CLIP, "Speed 1Ã— (normal)", &[]),
    c(Cmd::Speed(1.5), CLIP, "Speed 1.5Ã—", &[]),
    c(Cmd::Speed(2.0), CLIP, "Speed 2Ã—", &[]),
    c(Cmd::Speed(4.0), CLIP, "Speed 4Ã—", &[]),
    c(Cmd::Volume(0.1), CLIP, "Volume up", &[alt(Key::Equals), alt(Key::Plus)]),
    c(Cmd::Volume(-0.1), CLIP, "Volume down", &[alt(Key::Minus)]),
    c(Cmd::FitOrFill, CLIP, "Fit or fill the frame", &[alt(Key::F)]),
    c(Cmd::ResetPlace, CLIP, "Reset size, place and crop", &[alt(Key::R)]),
    c(Cmd::GrabFrame, CLIP, "Grab the frame as a picture (on top, to move around)", &[alt(Key::G)]),
    c(Cmd::ShowMore { before: true, seconds: 1.0 }, CLIP, "Show 1 s more of the video before", &[ctrl(Key::OpenBracket)]),
    c(Cmd::ShowMore { before: false, seconds: 1.0 }, CLIP, "Show 1 s more of the video after", &[ctrl(Key::CloseBracket)]),
    c(Cmd::ShowMore { before: true, seconds: 5.0 }, CLIP, "Show 5 s more of the video before", &[ctrl_shift(Key::OpenBracket), ctrl_shift(Key::OpenCurlyBracket)]),
    c(Cmd::ShowMore { before: false, seconds: 5.0 }, CLIP, "Show 5 s more of the video after", &[ctrl_shift(Key::CloseBracket), ctrl_shift(Key::CloseCurlyBracket)]),
    c(Cmd::Ungroup, CLIP, "Ungroup layers", &[ctrl_shift(Key::G)]),
    c(Cmd::DetachSound, CLIP, "Detach sound onto its own track", &[alt(Key::D)]),
    c(Cmd::Unlink, CLIP, "Unlink from its linked clip", &[alt(Key::U)]),
    c(Cmd::MeasureLoudness, CLIP, "Measure loudness", &[]),
    c(Cmd::Normalize, CLIP, "Normalize to -14 LUFS", &[]),
    c(Cmd::Proxy, CLIP, "Make an editing proxy (smooth playback)", &[]),
    c(Cmd::DeleteProxy, CLIP, "Delete the editing proxy", &[]),
    c(Cmd::DetectScenes, CLIP, "Detect scenes (marks the cuts)", &[]),
    c(Cmd::EditInFolio, CLIP, "Edit the picture in Folio (Save there brings it back)", &[]),
    c(Cmd::ExportPart, CLIP, "Export the picked part as a video (from the first picked clip to the end of the last)", &[]),
    c(Cmd::EditFrameInFolio, CLIP, "Edit the frame in Folio (laid over the video; Save there brings it back)", &[]),
    c(Cmd::AutoReframe, CLIP, "Auto-reframe (follow the action)", &[]),
    c(Cmd::ResetColor, CLIP, "Reset color", &[]),
    c(Cmd::ResetEffects, CLIP, "Reset effects", &[]),
    c(Cmd::AddVideoTrack, TRACKS, "Add a video track", &[ctrl(Key::T)]),
    c(Cmd::AddAudioTrack, TRACKS, "Add an audio track", &[ctrl_shift(Key::T)]),
    c(Cmd::MuteTrack, TRACKS, "Mute or unmute the picked clip's track", &[alt(Key::M)]),
    c(Cmd::HideTrack, TRACKS, "Hide or show the picked clip's track", &[alt(Key::H)]),
    c(Cmd::LockTrack, TRACKS, "Lock or unlock the picked clip's track", &[alt(Key::L)]),
    c(Cmd::Snap, TRACKS, "Snapping on or off", &[k(Key::N)]),
    c(Cmd::Import, MEDIA, "Import filesâ€¦", &[ctrl(Key::I)]),
    c(Cmd::MediaStep(true), MEDIA, "Pick the file above in Media", &[k(Key::PageUp)]),
    c(Cmd::MediaStep(false), MEDIA, "Pick the file below in Media", &[k(Key::PageDown)]),
    c(Cmd::PlaceMedia, MEDIA, "Put the picked file on the timeline at the playhead", &[k(Key::E), k(Key::Insert)]),
    c(Cmd::FindMedia, MEDIA, "Search Media", &[ctrl(Key::F)]),
    c(Cmd::Projects, PROJECT, "Projects", &[ctrl(Key::O)]),
    c(Cmd::NewProject, PROJECT, "New project", &[ctrl(Key::N)]),
    c(Cmd::Export, PROJECT, "Export", &[ctrl(Key::E)]),
    c(Cmd::Queue, PROJECT, "Render queue and presets", &[ctrl_shift(Key::E)]),
    c(Cmd::Shape(0), PROJECT, "Shape 16:9", &[alt(Key::Num1)]),
    c(Cmd::Shape(1), PROJECT, "Shape 9:16", &[alt(Key::Num2)]),
    c(Cmd::Shape(2), PROJECT, "Shape 1:1", &[alt(Key::Num3)]),
    c(Cmd::EvenLoudness, PROJECT, "Even loudness on export, on or off", &[alt(Key::E)]),
    c(Cmd::NextFormat, PROJECT, "Next export format", &[alt(Key::X)]),
    c(Cmd::Scopes, PROJECT, "Video scopes on or off", &[alt(Key::S)]),
    c(Cmd::Boss, PROJECT, "Codex: edit the video with Codex (chat, full edit, shorts)", &[alt(Key::B)]),
    c(Cmd::Commands, PROJECT, "All commands and keys", &[k(Key::F1), ctrl_shift(Key::P), shift(Key::Questionmark), k(Key::Questionmark), shift(Key::Slash)]),
];

/// The command whose key was pressed this frame, if any (the key press is taken out of the input).
pub fn pressed(input: &mut InputState) -> Option<Cmd> {
    // The clipboard keys arrive as their own events on Windows.
    for (event, cmd) in [(Event::Copy, Cmd::Copy), (Event::Cut, Cmd::CutClips)] {
        if let Some(at) = input.events.iter().position(|e| *e == event) {
            input.events.remove(at);
            return Some(cmd);
        }
    }
    if let Some(at) = input.events.iter().position(|e| matches!(e, Event::Paste(_))) {
        input.events.remove(at);
        return Some(Cmd::Paste);
    }
    COMMANDS
        .iter()
        .find(|command| command.keys.iter().any(|s| s.take(input)))
        .map(|command| command.cmd)
}

/// The keys shown for a command, as "Space or K".
pub fn keys_label(command: &Command) -> String {
    command.keys.iter().map(Shortcut::label).collect::<Vec<_>>().join(" or ")
}

/// Commands matching a search: every word must appear in the name, the group or the keys.
pub fn search(query: &str) -> Vec<&'static Command> {
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    COMMANDS
        .iter()
        .filter(|command| {
            let text = format!("{} {} {}", command.name, command.group, keys_label(command)).to_lowercase();
            words.iter().all(|w| text.contains(w))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_key_does_two_things() {
        let mut seen = std::collections::HashMap::new();
        for command in COMMANDS {
            for key in command.keys {
                if let Some(other) = seen.insert(*key, command.name) {
                    panic!("{} is on both {other:?} and {:?}", key.label(), command.name);
                }
            }
        }
    }

    #[test]
    fn canopy_keys_are_left_alone() {
        let canopy = [Key::Tab, Key::J, Key::W, Key::B, Key::K, Key::Num1, Key::Num2, Key::Num9];
        for command in COMMANDS {
            for key in command.keys {
                assert!(!(key.ctrl && canopy.contains(&key.key)), "{} is Canopy's", key.label());
                assert!(key.key != Key::F11, "F11 is Canopy's full screen");
            }
        }
    }

    #[test]
    fn modifiers_must_match_exactly() {
        let mut input = InputState::default();
        let press = |modifiers| Event::Key { key: Key::ArrowLeft, physical_key: None, pressed: true, repeat: false, modifiers };
        input.events.push(press(Modifiers::ALT));
        assert_eq!(pressed(&mut input), Some(Cmd::NudgeFrames(-1)), "Alt+â† isn't a plain â†");
        input.events.push(press(Modifiers::NONE));
        assert_eq!(pressed(&mut input), Some(Cmd::Frame(true)));
        assert!(input.events.is_empty());
    }

    #[test]
    fn search_finds_by_words_and_keys() {
        assert!(search("split every").iter().any(|c| c.cmd == Cmd::SplitAll));
        assert!(search("ctrl+e").iter().any(|c| c.cmd == Cmd::Export));
        assert!(search("speed 2").iter().any(|c| c.cmd == Cmd::Speed(2.0)));
    }
}
