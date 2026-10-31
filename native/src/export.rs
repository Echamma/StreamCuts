//! Export renders the whole timeline with one FFmpeg run: every clip is an input, video clips are laid over a black
//! canvas bottom track first, sound from every audible clip is delayed to its place and mixed.

use crate::ffmpeg::{command, ffmpeg};
use crate::project::{MediaKind, Project, TrackKind};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

/// The FFmpeg arguments that render `project` to an MP4 at `output`. Errors when there is nothing to export.
pub fn arguments(project: &Project, output: &Path) -> Result<Vec<String>, String> {
    let total = project.duration();
    if total <= 0.0 {
        return Err("Add something to the timeline first.".into());
    }
    let (w, h, fps) = (project.width, project.height, project.fps);
    let mut args: Vec<String> = ["-v", "error", "-y"].iter().map(|s| s.to_string()).collect();
    let mut filters: Vec<String> = vec![format!("color=c=black:s={w}x{h}:r={fps}:d={total:.3}[base0]")];
    let mut audio_labels = Vec::new();
    let mut input = 0;
    let mut base = 0;
    // Bottom video track first, so tracks higher up end up in front.
    let video_tracks: Vec<_> = project.tracks.iter().filter(|t| t.kind == TrackKind::Video).rev().collect();
    let audio_tracks: Vec<_> = project.tracks.iter().filter(|t| t.kind == TrackKind::Audio).collect();
    for track in video_tracks.iter().chain(audio_tracks.iter()) {
        for clip in &track.clips {
            let Some(media) = project.media(&clip.media_id) else { continue };
            if media.kind == MediaKind::Image {
                args.extend(["-loop".into(), "1".into(), "-t".into(), format!("{:.3}", clip.duration)]);
            } else {
                args.extend(["-ss".into(), format!("{:.3}", clip.source_in), "-t".into(), format!("{:.3}", clip.duration)]);
            }
            args.extend(["-i".into(), media.path.to_string_lossy().into_owned()]);
            let shows = track.kind == TrackKind::Video && !track.hidden && media.kind != MediaKind::Audio;
            if shows {
                filters.push(format!(
                    "[{input}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,fps={fps},format=yuv420p,setpts=PTS-STARTPTS+{start:.3}/TB[v{input}]",
                    start = clip.start
                ));
                filters.push(format!("[base{base}][v{input}]overlay=eof_action=pass[base{}]", base + 1));
                base += 1;
            }
            let hidden_video = track.kind == TrackKind::Video && track.hidden;
            if media.has_audio && !track.muted && !hidden_video && clip.volume > 0.0 {
                let delay = (clip.start * 1000.0).round() as u64;
                filters.push(format!(
                    "[{input}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume={:.3},adelay={delay}|{delay}[a{input}]",
                    clip.volume
                ));
                audio_labels.push(format!("[a{input}]"));
            }
            input += 1;
        }
    }
    filters.push(format!("[base{base}]format=yuv420p[vout]"));
    if !audio_labels.is_empty() {
        filters.push(format!("{}amix=inputs={}:normalize=0:duration=longest[aout]", audio_labels.join(""), audio_labels.len()));
    }
    args.extend(["-filter_complex".into(), filters.join(";"), "-map".into(), "[vout]".into()]);
    if !audio_labels.is_empty() {
        args.extend(["-map".into(), "[aout]".into(), "-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
    }
    args.extend(
        ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-t"]
            .iter()
            .map(|s| s.to_string()),
    );
    args.push(format!("{total:.3}"));
    args.extend(["-progress".into(), "pipe:1".into(), "-nostats".into()]);
    args.push(output.to_string_lossy().into_owned());
    Ok(args)
}

/// A running export, readable from the UI.
pub struct Export {
    /// Per mille done.
    pub progress: Arc<AtomicU32>,
    pub cancel: Arc<AtomicBool>,
    pub result: std::sync::mpsc::Receiver<Result<(), String>>,
}

/// Starts rendering `project` to `output` in the background.
pub fn start(project: &Project, output: &Path, ctx: egui::Context) -> Result<Export, String> {
    let args = arguments(project, output)?;
    let total = project.duration();
    let progress = Arc::new(AtomicU32::new(0));
    let cancel = Arc::new(AtomicBool::new(false));
    let (send, result) = std::sync::mpsc::channel();
    let mut child = command(&ffmpeg()).args(&args).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("FFmpeg couldn't start ({e})."))?;
    let (progress_out, cancel_in) = (progress.clone(), cancel.clone());
    let output = output.to_path_buf();
    std::thread::spawn(move || {
        let stdout = child.stdout.take().expect("piped");
        let mut stderr = child.stderr.take().expect("piped");
        let errors = std::thread::spawn(move || {
            let mut text = String::new();
            let _ = std::io::Read::read_to_string(&mut stderr, &mut text);
            text
        });
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if cancel_in.load(Ordering::Relaxed) {
                let _ = child.kill();
                break;
            }
            if let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.trim().parse::<f64>().ok()) {
                progress_out.store(((us / 1e6 / total) * 1000.0).clamp(0.0, 1000.0) as u32, Ordering::Relaxed);
                ctx.request_repaint();
            }
        }
        let status = child.wait();
        let errors = errors.join().unwrap_or_default();
        let outcome = if cancel_in.load(Ordering::Relaxed) {
            let _ = std::fs::remove_file(&output);
            Err("Export stopped.".into())
        } else {
            match status {
                Ok(s) if s.success() => Ok(()),
                _ => Err(format!("Export failed: {}", errors.lines().last().unwrap_or("FFmpeg stopped"))),
            }
        };
        let _ = send.send(outcome);
        ctx.request_repaint();
    });
    Ok(Export { progress, cancel, result })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{Media, Project, new_id};
    use std::path::PathBuf;

    fn media(kind: MediaKind, duration: f64, has_audio: bool) -> Media {
        Media { id: new_id(), path: PathBuf::from(format!("C:/m/{}.mp4", new_id())), name: "m".into(), kind, duration, width: 1280, height: 720, has_audio }
    }

    #[test]
    fn an_empty_timeline_has_nothing_to_export() {
        assert!(arguments(&Project::new("Empty"), Path::new("out.mp4")).is_err());
    }

    #[test]
    fn clips_become_inputs_laid_over_black_and_mixed() {
        let mut project = Project::new("Cut");
        let video = project.add_media(media(MediaKind::Video, 10.0, true));
        let music = project.add_media(media(MediaKind::Audio, 30.0, true));
        let still = project.add_media(media(MediaKind::Image, 0.0, false));
        let a = project.place(&video, None, 0.0).unwrap();
        project.trim_start(&a, 2.0);
        project.place(&music, None, 0.0);
        let upper = project.add_track(TrackKind::Video);
        project.place(&still, Some(upper), 3.0);
        let args = arguments(&project, Path::new("C:/out/cut.mp4")).unwrap();
        let joined = args.join(" ");
        assert_eq!(args.iter().filter(|a| *a == "-i").count(), 3);
        assert!(joined.contains("-ss 2.000 -t 8.000 -i"), "the trimmed clip seeks into its source: {joined}");
        assert!(joined.contains("-loop 1 -t 5.000 -i"), "stills loop for their length");
        let graph = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(graph.starts_with("color=c=black:s=1920x1080:r=30:d=30.000[base0]"));
        let video_at = graph.find("setpts=PTS-STARTPTS+2.000/TB").unwrap();
        let still_at = graph.find("setpts=PTS-STARTPTS+3.000/TB").unwrap();
        assert!(video_at < still_at, "the lower track is laid down before the upper one");
        assert!(graph.contains("adelay=2000|2000"));
        assert!(graph.contains("amix=inputs=2"));
        assert!(joined.ends_with("-t 30.000 -progress pipe:1 -nostats C:/out/cut.mp4"));
    }

    #[test]
    fn muted_tracks_add_no_sound() {
        let mut project = Project::new("Quiet");
        let video = project.add_media(media(MediaKind::Video, 4.0, true));
        let clip = project.place(&video, None, 0.0).unwrap();
        let track = project.find(&clip).unwrap().track;
        project.tracks[track].muted = true;
        let args = arguments(&project, Path::new("o.mp4")).unwrap();
        assert!(!args.contains(&"[aout]".to_string()));
    }
}
