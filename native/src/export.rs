//! Export renders the whole timeline with one FFmpeg run: every clip is an input, video clips are laid over a black
//! canvas bottom track first, sound from every audible clip is delayed to its place and mixed, and captions are burned
//! in last from an ASS file (FFmpeg runs in a folder holding it and the caption font, so no paths need escaping).

use crate::captions;
use crate::ffmpeg::{command, ffmpeg};
use crate::project::{MediaKind, Project, TrackKind, new_id};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

/// The captions file an export's FFmpeg reads from its working folder.
const CAPTIONS: &str = "captions.ass";

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
                args.extend(["-ss".into(), format!("{:.3}", clip.source_in), "-t".into(), format!("{:.3}", clip.source_length())]);
            }
            args.extend(["-i".into(), media.path.to_string_lossy().into_owned()]);
            let shows = track.kind == TrackKind::Video && !track.hidden && media.kind != MediaKind::Audio;
            if shows {
                // Fades work on the picture's alpha, so a clip fades to whatever is below it (black when nothing is).
                let pace = if (clip.speed - 1.0).abs() < 1e-6 { "PTS-STARTPTS".to_string() } else { format!("(PTS-STARTPTS)/{:.4}", clip.speed) };
                let mut chain = format!("[{input}:v]{},fps={fps},format=yuva420p,setpts={pace}", clip.picture().filter(w, h));
                if clip.fade_in > 0.0 {
                    chain.push_str(&format!(",fade=t=in:st=0:d={:.3}:alpha=1", clip.fade_in));
                }
                if clip.fade_out > 0.0 {
                    chain.push_str(&format!(",fade=t=out:st={:.3}:d={:.3}:alpha=1", (clip.duration - clip.fade_out).max(0.0), clip.fade_out));
                }
                filters.push(format!("{chain},setpts=PTS+{start:.3}/TB[v{input}]", start = clip.start));
                filters.push(format!("[base{base}][v{input}]overlay=eof_action=pass[base{}]", base + 1));
                base += 1;
            }
            let hidden_video = track.kind == TrackKind::Video && track.hidden;
            if media.has_audio && !track.muted && !hidden_video && clip.volume > 0.0 {
                let delay = (clip.start * 1000.0).round() as u64;
                let mut chain = format!("[{input}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume={:.3}", clip.volume);
                if let Some(tempo) = crate::ffmpeg::atempo(clip.speed) {
                    chain.push_str(&format!(",{tempo}"));
                }
                if clip.fade_in > 0.0 {
                    chain.push_str(&format!(",afade=t=in:st=0:d={:.3}", clip.fade_in));
                }
                if clip.fade_out > 0.0 {
                    chain.push_str(&format!(",afade=t=out:st={:.3}:d={:.3}", (clip.duration - clip.fade_out).max(0.0), clip.fade_out));
                }
                filters.push(format!("{chain},adelay={delay}|{delay}[a{input}]"));
                audio_labels.push(format!("[a{input}]"));
            }
            input += 1;
        }
    }
    let captions = if project.has_text() { format!("subtitles={CAPTIONS}:fontsdir=.,") } else { String::new() };
    filters.push(format!("[base{base}]{captions}format=yuv420p[vout]"));
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
    // Captions: the ASS file and its font go in a folder of their own that FFmpeg runs in.
    let folder = if !project.has_text() {
        None
    } else {
        let folder = std::env::temp_dir().join(format!("streamcuts-export-{}", new_id()));
        std::fs::create_dir_all(&folder)
            .and_then(|_| std::fs::write(folder.join(CAPTIONS), captions::ass(project)))
            .and_then(|_| std::fs::write(folder.join(captions::FONT_FILE), captions::font_bytes()))
            .map_err(|e| format!("Couldn't get the captions ready ({e})."))?;
        Some(folder)
    };
    let mut ffmpeg_run = command(&ffmpeg());
    ffmpeg_run.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(folder) = &folder {
        ffmpeg_run.current_dir(folder);
    }
    let mut child = ffmpeg_run.spawn().map_err(|e| format!("FFmpeg couldn't start ({e})."))?;
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
        if let Some(folder) = folder {
            let _ = std::fs::remove_dir_all(folder);
        }
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
        let video_at = graph.find("setpts=PTS+2.000/TB").unwrap();
        let still_at = graph.find("setpts=PTS+3.000/TB").unwrap();
        assert!(video_at < still_at, "the lower track is laid down before the upper one");
        assert!(graph.contains("adelay=2000|2000"));
        assert!(graph.contains("amix=inputs=2"));
        assert!(joined.ends_with("-t 30.000 -progress pipe:1 -nostats C:/out/cut.mp4"));
    }

    /// Needs FFmpeg on PATH: renders a real two-track timeline and checks the result plays for the right length.
    #[test]
    fn renders_a_timeline_with_ffmpeg() {
        let dir = std::env::temp_dir().join(format!("streamcuts-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("clip.mp4");
        let still = dir.join("still.png");
        assert!(command(&ffmpeg()).args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2", "-f", "lavfi", "-i", "sine=duration=2", "-shortest", "-pix_fmt", "yuv420p"]).arg(&clip).status().unwrap().success());
        assert!(command(&ffmpeg()).args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=orange:s=64x64", "-frames:v", "1"]).arg(&still).status().unwrap().success());
        let mut project = Project::new("Render");
        project.width = 320;
        project.height = 180;
        let video = project.add_media(crate::ffmpeg::probe(&clip).unwrap());
        let picture = project.add_media(crate::ffmpeg::probe(&still).unwrap());
        let first = project.place(&video, None, 0.0).unwrap();
        (project.clip_mut(&first).unwrap().fade_in, project.clip_mut(&first).unwrap().fade_out) = (0.5, 0.5);
        // Twice as fast: the 2-second clip covers 1 second, and FFmpeg has to take setpts and atempo.
        project.set_speed(&first, 2.0);
        let upper = project.add_track(TrackKind::Video);
        let still_clip = project.place(&picture, Some(upper), 1.0).unwrap();
        project.trim_end(&still_clip, 2.5);
        let caption = crate::project::Caption { id: new_id(), start: 0.2, end: 2.0, text: "Burned in".into(), words: Vec::new() };
        project.add_captions(0.0, 2.5, vec![caption]);
        assert!(arguments(&project, Path::new("o.mp4")).unwrap().iter().any(|a| a.contains("subtitles=captions.ass:fontsdir=.,format=yuv420p[vout]")));
        let output = dir.join("out.mp4");
        let run = start(&project, &output, egui::Context::default()).unwrap();
        assert_eq!(run.result.recv().unwrap(), Ok(()));
        let rendered = crate::ffmpeg::probe(&output).unwrap();
        assert!((rendered.duration - 2.5).abs() < 0.15, "rendered {}", rendered.duration);
        assert!(rendered.has_audio && rendered.width == 320);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn fades_and_fill_reach_the_graph() {
        let mut project = Project::new("Short");
        (project.width, project.height) = (1080, 1920);
        let video = project.add_media(media(MediaKind::Video, 10.0, true));
        let id = project.place(&video, None, 0.0).unwrap();
        let clip = project.clip_mut(&id).unwrap();
        (clip.fade_in, clip.fade_out) = (0.5, 1.0);
        clip.framing = crate::project::Framing::Fill { x: 0.25, y: 0.5 };
        clip.grade.saturation = 1.5;
        project.set_speed(&id, 2.0);
        let args = arguments(&project, Path::new("o.mp4")).unwrap();
        let graph = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(graph.contains("force_original_aspect_ratio=increase,crop=1080:1920:(iw-ow)*0.250:(ih-oh)*0.500"), "{graph}");
        assert!(graph.contains("crop=1080:1920:(iw-ow)*0.250:(ih-oh)*0.500,eq=brightness=0.000:contrast=1.000:saturation=1.500,fps="));
        assert!(graph.contains("setpts=(PTS-STARTPTS)/2.0000,fade=t=in:st=0:d=0.500:alpha=1,fade=t=out:st=4.000:d=1.000:alpha=1"), "{graph}");
        assert!(graph.contains("atempo=2.0000,afade=t=in:st=0:d=0.500,afade=t=out:st=4.000:d=1.000,adelay=0|0"));
        assert!(args.join(" ").contains("-ss 0.000 -t 10.000 -i"), "the whole source still goes in");
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
