//! Export renders the whole timeline with one FFmpeg run: every clip is an input, video clips are laid over a black
//! canvas bottom track first, sound from every audible clip is delayed to its place and mixed, and captions are burned
//! in last from an ASS file (FFmpeg runs in a folder holding it and the caption font, so no paths need escaping).

use crate::captions;
use crate::ffmpeg::{command, ffmpeg, is_gif};
use crate::project::{ExportFormat, MediaKind, Project, TrackKind, new_id};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

/// A way to deliver, as the web StreamCuts' export presets: frame size, frame rate, format and loudness.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Preset {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub format: ExportFormat,
    #[serde(default)]
    pub even_loudness: bool,
}

impl Preset {
    /// The web StreamCuts' platform presets.
    pub fn built_in() -> Vec<Preset> {
        let preset = |name: &str, width, height, fps| Preset {
            name: name.into(),
            width,
            height,
            fps,
            format: ExportFormat::Mp4,
            even_loudness: true,
        };
        vec![
            preset("TikTok", 1080, 1920, 30),
            preset("Instagram Reels", 1080, 1920, 30),
            preset("YouTube Shorts", 1080, 1920, 60),
            preset("Instagram Square", 1080, 1080, 30),
            preset("Instagram Portrait", 1080, 1350, 30),
            preset("YouTube 1080p", 1920, 1080, 30),
            preset("YouTube 4K", 3840, 2160, 30),
        ]
    }

    /// The project's own settings, under `name`.
    pub fn of(project: &Project, name: &str) -> Preset {
        let (width, height, fps, format, even_loudness) = (
            project.width,
            project.height,
            project.fps,
            project.export_format,
            project.even_loudness,
        );
        Preset {
            name: name.trim().into(),
            width,
            height,
            fps,
            format,
            even_loudness,
        }
    }

    /// The project as this preset renders it.
    pub fn apply(&self, project: &Project) -> Project {
        let mut out = project.clone();
        (
            out.width,
            out.height,
            out.fps,
            out.export_format,
            out.even_loudness,
        ) = (
            self.width,
            self.height,
            self.fps,
            self.format,
            self.even_loudness,
        );
        out
    }

    pub fn describe(&self) -> String {
        let sound = if self.even_loudness && self.format != ExportFormat::Audio {
            " · even loudness"
        } else {
            ""
        };
        match self.format {
            ExportFormat::Audio => format!("{}{sound}", self.format.label()),
            _ => format!(
                "{}×{} · {} fps · {}{sound}",
                self.width,
                self.height,
                self.fps,
                self.format.label()
            ),
        }
    }

    /// Your saved presets, from `dir` (none when there are none yet).
    pub fn load(dir: &Path) -> Vec<Preset> {
        std::fs::read(dir.join(PRESETS))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save(dir: &Path, presets: &[Preset]) -> Result<(), String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_vec_pretty(presets).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(PRESETS), json)
            .map_err(|e| format!("Couldn't save the preset ({e})."))
    }
}

/// Where your saved presets live, in the app's data folder.
const PRESETS: &str = "export-presets.json";

/// One render in the queue: the project as it was when queued, at a preset's settings.
pub struct Queued {
    pub id: String,
    pub name: String,
    pub project: Project,
    pub status: Status,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    Waiting,
    Rendering(PathBuf),
    Done(PathBuf),
    Failed(String),
}

impl Queued {
    pub fn new(project: &Project, preset: &Preset) -> Self {
        Queued {
            id: new_id(),
            name: format!("{} - {}", project.name, preset.name),
            project: preset.apply(project),
            status: Status::Waiting,
        }
    }
}

/// The captions file an export's FFmpeg reads from its working folder.
const CAPTIONS: &str = "captions.ass";

/// The FFmpeg arguments that render `project` to an MP4 at `output`. Errors when there is nothing to export.
pub fn arguments(project: &Project, output: &Path) -> Result<Vec<String>, String> {
    let total = project.duration();
    if total <= 0.0 {
        return Err("Add something to the timeline first.".into());
    }
    let (w, h, fps) = (project.width, project.height, project.fps);
    let mut args: Vec<String> = ["-v", "error", "-y"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let mut filters: Vec<String> = vec![format!(
        "color=c=black:s={w}x{h}:r={fps}:d={total:.3}[base0]"
    )];
    let mut audio_labels = Vec::new();
    let mut input = 0;
    let mut base = 0;
    // Bottom video track first, so tracks higher up end up in front.
    let video_tracks: Vec<_> = project
        .tracks
        .iter()
        .filter(|t| t.kind == TrackKind::Video)
        .rev()
        .collect();
    let audio_tracks: Vec<_> = project
        .tracks
        .iter()
        .filter(|t| t.kind == TrackKind::Audio)
        .collect();
    // A blurred box: the picture so far (the tracks up to `track`, or all of them) with the box cut out, blurred and
    // laid back for its time. Tracks laid on after it stay sharp.
    let blur_filter = |k: usize, blur: &crate::project::Blur, base: usize| {
        let (x, y, bw, bh) = blur.pixels(w, h);
        format!(
            "[base{base}]split[bk{k}][bc{k}];[bc{k}]crop={bw}:{bh}:{x}:{y},gblur=sigma={sigma:.2}:steps=3[bz{k}];[bk{k}][bz{k}]overlay={x}:{y}:enable='between(t,{start:.3},{end:.3})'[base{next}]",
            sigma = blur.sigma(h),
            start = blur.start,
            end = blur.end,
            next = base + 1
        )
    };
    let blurs: Vec<(usize, &crate::project::Blur, Option<usize>)> = project
        .blurs
        .iter()
        .enumerate()
        .filter(|(_, b)| b.end > b.start)
        .map(|(k, b)| (k, b, project.blur_track(b)))
        .collect();
    for track in video_tracks.iter().chain(audio_tracks.iter()) {
        for clip in &track.clips {
            let Some(media) = project.media(&clip.media_id) else {
                continue;
            };
            let crossfade_out = project.crossfade_after(&clip.id);
            let crossfade_in = project.crossfade_before(&clip.id).map_or(0.0, |(_, d)| d);
            // An animated picture plays round and round, starting wherever the clip's source time is in its loop. FFmpeg
            // has no `-loop` for GIFs, so a GIF of one frame goes round the same way.
            let looped = media.loop_length();
            let phase = looped.map_or(0.0, |length| clip.source_in.rem_euclid(length));
            if looped.is_some() || (media.kind == MediaKind::Image && is_gif(&media.path)) {
                args.extend([
                    "-stream_loop".into(),
                    "-1".into(),
                    "-t".into(),
                    format!(
                        "{:.3}",
                        phase + (clip.duration + crossfade_out) * clip.speed
                    ),
                ]);
            } else if media.kind == MediaKind::Image {
                args.extend([
                    "-loop".into(),
                    "1".into(),
                    "-t".into(),
                    format!("{:.3}", clip.duration + crossfade_out),
                ]);
            } else {
                args.extend([
                    "-ss".into(),
                    format!("{:.3}", clip.source_in),
                    "-t".into(),
                    format!("{:.3}", (clip.duration + crossfade_out) * clip.speed),
                ]);
            }
            args.extend(["-i".into(), media.path.to_string_lossy().into_owned()]);
            let shows =
                track.kind == TrackKind::Video && !track.hidden && media.kind != MediaKind::Audio;
            if shows {
                // Fades work on the picture's alpha, so a clip fades to whatever is below it (black when nothing is).
                let pace = if (clip.speed - 1.0).abs() < 1e-6 {
                    "PTS-STARTPTS".to_string()
                } else {
                    format!("(PTS-STARTPTS)/{:.4}", clip.speed)
                };
                // Each time round, a loop starts from its first frame, so the way into the first one is trimmed off.
                let trim = if phase > 0.0 {
                    format!("trim=start={phase:.3},")
                } else {
                    String::new()
                };
                // A placed clip is cut and sized after framing, then laid on the frame at its place (see `Place`).
                let placed = clip.place.filter(w, h);
                // The speed changes the frames' times first; then the clip's retime brings them to the project's
                // frame rate (sped up skips frames, slowed down repeats, blends or makes them), so every clip is at it.
                let mut chain = format!(
                    "[{input}:v]{trim}{}{},setpts={pace},{},format=yuva420p",
                    clip.picture().filter_at(w, h, clip.source_in, 1.0),
                    placed
                        .as_ref()
                        .map_or(String::new(), |(cut, ..)| format!(",{cut}")),
                    clip.retime.filter(fps)
                );
                // A blur-through mixes each side towards a blurred copy of itself across the crossfade (`K`, 0 sharp to
                // 1 blurred, by the clip's own time T): the outgoing clip on its way out, the incoming one in reverse.
                let blur = |chain: &mut String, side: &str, k: String| {
                    let sigma = crate::project::BLUR_THROUGH * h as f32;
                    chain.push_str(&format!(",split[s{input}{side}][b{input}{side}];[b{input}{side}]gblur=sigma={sigma:.2}:steps=3[g{input}{side}];[s{input}{side}][g{input}{side}]blend=all_expr='A*(1-{k})+B*{k}'"));
                };
                if crossfade_out > 0.0
                    && project.transition_after(&clip.id)
                        == Some(crate::project::Transition::BlurThrough)
                {
                    blur(
                        &mut chain,
                        "out",
                        format!("clip((T-{:.3})/{crossfade_out:.3},0,1)", clip.duration),
                    );
                }
                if crossfade_in > 0.0 && clip.transition == crate::project::Transition::BlurThrough
                {
                    blur(
                        &mut chain,
                        "in",
                        format!("(1-clip(T/{crossfade_in:.3},0,1))"),
                    );
                }
                // A wipe, slide, circle and the like: FFmpeg's xfade from a transparent start of the crossfade's length
                // into the clip, so the clip arrives over the one going out underneath it. A placed (resized) clip
                // isn't frame-sized, so it dissolves in instead.
                let xfade = clip
                    .transition
                    .xfade()
                    .filter(|_| crossfade_in > 0.0 && placed.is_none());
                if let Some(style) = xfade {
                    chain.push_str(&format!(
                        ",settb=1/{fps}[c{input}];color=black@0:s={w}x{h}:r={fps}:d={crossfade_in:.3},format=yuva420p,settb=1/{fps}[t{input}];[t{input}][c{input}]xfade=transition={style}:duration={crossfade_in:.3}:offset=0"
                    ));
                }
                let fade_in = if xfade.is_some() {
                    0.0
                } else if crossfade_in > 0.0 {
                    crossfade_in
                } else {
                    clip.fade_in
                };
                if fade_in > 0.0 {
                    chain.push_str(&format!(",fade=t=in:st=0:d={fade_in:.3}:alpha=1"));
                }
                if clip.fade_out > 0.0 && crossfade_out == 0.0 {
                    chain.push_str(&format!(
                        ",fade=t=out:st={:.3}:d={:.3}:alpha=1",
                        (clip.duration - clip.fade_out).max(0.0),
                        clip.fade_out
                    ));
                }
                filters.push(format!(
                    "{chain},setpts=PTS+{start:.3}/TB[v{input}]",
                    start = clip.start
                ));
                let at = placed.map_or(String::new(), |(_, x, y)| format!("x={x}:y={y}:"));
                filters.push(format!(
                    "[base{base}][v{input}]overlay={at}eof_action=pass[base{}]",
                    base + 1
                ));
                base += 1;
            }
            let hidden_video = track.kind == TrackKind::Video && track.hidden;
            if media.has_audio
                && !track.muted
                && !hidden_video
                && clip.volume > 0.0
                && !project.sounds_elsewhere(clip)
            {
                let delay = (clip.start * 1000.0).round() as u64;
                let mut chain = format!(
                    "[{input}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume={:.3}",
                    clip.volume
                );
                if let Some(sound) = clip.sound.filter() {
                    chain.push_str(&format!(",{sound}"));
                }
                if let Some(tempo) = crate::ffmpeg::speed_sound(clip.speed, clip.pitch_shift) {
                    chain.push_str(&format!(",{tempo}"));
                }
                let fade_in = if crossfade_in > 0.0 {
                    crossfade_in
                } else {
                    clip.fade_in
                };
                if fade_in > 0.0 {
                    chain.push_str(&format!(",afade=t=in:st=0:d={fade_in:.3}"));
                }
                if crossfade_out > 0.0 {
                    chain.push_str(&format!(
                        ",afade=t=out:st={:.3}:d={crossfade_out:.3}",
                        clip.duration
                    ));
                } else if clip.fade_out > 0.0 {
                    chain.push_str(&format!(
                        ",afade=t=out:st={:.3}:d={:.3}",
                        (clip.duration - clip.fade_out).max(0.0),
                        clip.fade_out
                    ));
                }
                filters.push(format!("{chain},adelay={delay}|{delay}[a{input}]"));
                audio_labels.push(format!("[a{input}]"));
            }
            input += 1;
        }
        // Blurs of the track just laid on (and those under it) go on before the tracks above.
        if track.kind == TrackKind::Video {
            let index = project.tracks.iter().position(|t| t.id == track.id);
            for &(k, blur, _) in blurs.iter().filter(|(_, _, on)| on.is_some() && *on == index) {
                filters.push(blur_filter(k, blur, base));
                base += 1;
            }
        }
    }
    // Blurs of every track: over all of them, under the text.
    for &(k, blur, _) in blurs.iter().filter(|(_, _, on)| on.is_none()) {
        filters.push(blur_filter(k, blur, base));
        base += 1;
    }
    let captions = if project.has_text() {
        format!("subtitles={CAPTIONS}:fontsdir=.,")
    } else {
        String::new()
    };
    filters.push(format!("[base{base}]{captions}format=yuv420p[vout]"));
    if !audio_labels.is_empty() {
        let mix = format!(
            "{}amix=inputs={}:normalize=0:duration=longest",
            audio_labels.join(""),
            audio_labels.len()
        );
        if project.even_loudness {
            // One pass of loudnorm to -14 LUFS (what social apps play at); it works at 192 kHz, so come back to 48.
            filters.push(format!("{mix}[mixed]"));
            filters.push("[mixed]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]".into());
        } else {
            filters.push(format!("{mix}[aout]"));
        }
    }
    let format = project.export_format;
    if format == ExportFormat::Audio && audio_labels.is_empty() {
        return Err("Nothing on the timeline makes sound.".into());
    }
    if format == ExportFormat::Audio {
        // FFmpeg refuses a filter output nothing reads: the picture goes nowhere.
        filters.push("[vout]nullsink".into());
    }
    args.extend(["-filter_complex".into(), filters.join(";")]);
    if format != ExportFormat::Audio {
        args.extend(["-map".into(), "[vout]".into()]);
    }
    if !audio_labels.is_empty() {
        let sound: &[&str] = match format {
            ExportFormat::Prores | ExportFormat::Audio => &["-c:a", "pcm_s16le", "-ar", "48000"],
            _ => &["-c:a", "aac", "-b:a", "192k"],
        };
        args.extend(["-map".into(), "[aout]".into()]);
        args.extend(sound.iter().map(|s| s.to_string()));
    }
    let picture: &[&str] = match format {
        ExportFormat::Mp4 => &[
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
        ],
        // ProRes 422 HQ, 10-bit.
        ExportFormat::Prores => &[
            "-c:v",
            "prores_ks",
            "-profile:v",
            "3",
            "-pix_fmt",
            "yuv422p10le",
        ],
        ExportFormat::Av1 => &[
            "-c:v",
            "libsvtav1",
            "-preset",
            "8",
            "-crf",
            "32",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
        ],
        ExportFormat::Audio => &[],
    };
    args.extend(picture.iter().map(|s| s.to_string()));
    args.push("-t".into());
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
    let mut args = arguments(project, output)?;
    let total = project.duration();
    let progress = Arc::new(AtomicU32::new(0));
    let cancel = Arc::new(AtomicBool::new(false));
    let (send, result) = std::sync::mpsc::channel();
    // Each run gets a folder of its own that FFmpeg runs in: the filter graph goes in a file there (a timeline of a
    // hundred-odd clips makes a graph longer than Windows lets a command line be), with the captions and their font.
    let folder = std::env::temp_dir().join(format!("streamcuts-export-{}", new_id()));
    std::fs::create_dir_all(&folder).map_err(|e| format!("Couldn't get the export ready ({e})."))?;
    if let Some(at) = args.iter().position(|a| a == "-filter_complex") {
        let graph = folder.join("graph.txt");
        std::fs::write(&graph, &args[at + 1]).map_err(|e| format!("Couldn't get the export ready ({e})."))?;
        // FFmpeg 7 and later read an option's value from a file when its name starts with "-/".
        args[at] = "-/filter_complex".into();
        args[at + 1] = graph.to_string_lossy().into_owned();
    }
    if project.has_text() {
        std::fs::write(folder.join(CAPTIONS), captions::ass(project))
            .and_then(|_| std::fs::write(folder.join(captions::FONT_FILE), captions::font_bytes()))
            .map_err(|e| format!("Couldn't get the captions ready ({e})."))?;
    }
    let folder = Some(folder);
    let mut ffmpeg_run = command(&ffmpeg());
    ffmpeg_run
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(folder) = &folder {
        ffmpeg_run.current_dir(folder);
    }
    let mut child = ffmpeg_run
        .spawn()
        .map_err(|e| format!("FFmpeg couldn't start ({e})."))?;
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
            if let Some(us) = line
                .strip_prefix("out_time_us=")
                .and_then(|v| v.trim().parse::<f64>().ok())
            {
                progress_out.store(
                    ((us / 1e6 / total) * 1000.0).clamp(0.0, 1000.0) as u32,
                    Ordering::Relaxed,
                );
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
                _ => Err(format!(
                    "Export failed: {}",
                    errors.lines().last().unwrap_or("FFmpeg stopped")
                )),
            }
        };
        if let Some(folder) = folder {
            let _ = std::fs::remove_dir_all(folder);
        }
        let _ = send.send(outcome);
        ctx.request_repaint();
    });
    Ok(Export {
        progress,
        cancel,
        result,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{Media, Project, new_id};
    use std::path::PathBuf;

    fn media(kind: MediaKind, duration: f64, has_audio: bool) -> Media {
        Media {
            id: new_id(),
            path: PathBuf::from(format!("C:/m/{}.mp4", new_id())),
            name: "m".into(),
            kind,
            duration,
            width: 1280,
            height: 720,
            has_audio,
            frame_rate: 30.0,
            attributes: Default::default(),
        }
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
        assert!(
            joined.contains("-ss 2.000 -t 8.000 -i"),
            "the trimmed clip seeks into its source: {joined}"
        );
        assert!(
            joined.contains("-loop 1 -t 5.000 -i"),
            "stills loop for their length"
        );
        let graph = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(graph.starts_with("color=c=black:s=1920x1080:r=30:d=30.000[base0]"));
        let video_at = graph.find("setpts=PTS+2.000/TB").unwrap();
        let still_at = graph.find("setpts=PTS+3.000/TB").unwrap();
        assert!(
            video_at < still_at,
            "the lower track is laid down before the upper one"
        );
        assert!(graph.contains("adelay=2000|2000"));
        assert!(graph.contains("amix=inputs=2:normalize=0:duration=longest[aout]"));
        project.even_loudness = true;
        let args = arguments(&project, Path::new("C:/out/cut.mp4")).unwrap();
        let graph = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(graph.contains("[mixed]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]"));
        assert!(joined.ends_with("-t 30.000 -progress pipe:1 -nostats C:/out/cut.mp4"));
    }

    #[test]
    fn gifs_go_round_instead_of_holding_a_frame() {
        let mut project = Project::new("Gifs");
        let mut animated = media(MediaKind::Image, 2.96, false);
        animated.path = PathBuf::from("C:/m/horse.gif");
        let mut single = media(MediaKind::Image, 0.0, false);
        single.path = PathBuf::from("C:/m/dot.gif");
        let (animated, single) = (project.add_media(animated), project.add_media(single));
        project.place(&animated, None, 0.0);
        project.place(&single, None, 5.0);
        let joined = arguments(&project, Path::new("o.mp4")).unwrap().join(" ");
        assert!(
            joined.contains("-stream_loop -1 -t 5.000 -i C:/m/horse.gif"),
            "{joined}"
        );
        assert!(
            joined.contains("-stream_loop -1 -t 5.000 -i C:/m/dot.gif"),
            "{joined}"
        );
        assert!(
            !joined.contains("-loop 1"),
            "FFmpeg has no -loop for GIFs: {joined}"
        );
    }

    /// Needs FFmpeg on PATH: an animated GIF and a GIF of one frame export, the animated one going round.
    #[test]
    fn renders_gifs_with_ffmpeg() {
        let dir =
            std::env::temp_dir().join(format!("streamcuts-export-gif-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (animated, single) = (dir.join("animated.gif"), dir.join("single.gif"));
        for (source, path) in [
            ("color=c=red:s=160x90:r=10:d=1,hue=h=360*t", &animated),
            ("color=c=orange:s=160x90:r=1:d=1", &single),
        ] {
            assert!(
                command(&ffmpeg())
                    .args(["-v", "error", "-y", "-f", "lavfi", "-i", source])
                    .arg(path)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        let mut project = Project::new("Gifs");
        (project.width, project.height) = (160, 90);
        let animated = project.add_media(crate::ffmpeg::probe(&animated).unwrap());
        let single = project.add_media(crate::ffmpeg::probe(&single).unwrap());
        let first = project.place(&animated, None, 0.0).unwrap();
        project.trim_end(&first, 1.5);
        let second = project.place(&single, None, 1.5).unwrap();
        project.trim_end(&second, 2.5);
        let output = dir.join("out.mp4");
        let run = start(&project, &output, egui::Context::default()).unwrap();
        assert_eq!(run.result.recv().unwrap(), Ok(()));
        let rendered = crate::ffmpeg::probe(&output).unwrap();
        assert!(
            (rendered.duration - 2.5).abs() < 0.15,
            "rendered {}",
            rendered.duration
        );
        let frame = |t: f64| crate::ffmpeg::still(&output, t, 160, 90, Default::default()).unwrap();
        let difference = |a: &crate::ffmpeg::Frame, b: &crate::ffmpeg::Frame| {
            a.rgba
                .iter()
                .zip(&b.rgba)
                .map(|(x, y)| x.abs_diff(*y) as f64)
                .sum::<f64>()
                / a.rgba.len() as f64
        };
        assert!(difference(&frame(0.25), &frame(0.65)) > 20.0, "it animates");
        assert!(
            difference(&frame(0.25), &frame(1.25)) < 8.0,
            "and goes round again after a second"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Needs FFmpeg on PATH: a clip moved, resized and cropped over another shows where the preview puts it.
    #[test]
    fn renders_a_placed_clip_over_the_track_below() {
        let dir =
            std::env::temp_dir().join(format!("streamcuts-export-place-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (red, blue) = (dir.join("red.png"), dir.join("blue.png"));
        for (color, path) in [("red", &red), ("blue", &blue)] {
            assert!(
                command(&ffmpeg())
                    .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
                    .arg(format!("color=c={color}:s=160x90:d=1"))
                    .args(["-frames:v", "1"])
                    .arg(path)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        let mut project = Project::new("Placed");
        (project.width, project.height) = (160, 90);
        let red = project.add_media(crate::ffmpeg::probe(&red).unwrap());
        let blue = project.add_media(crate::ffmpeg::probe(&blue).unwrap());
        project.place(&red, None, 0.0).unwrap();
        let top = project.add_track(crate::project::TrackKind::Video);
        let placed = project.place(&blue, Some(top), 0.0).unwrap();
        // Half size, its middle at the top-right quarter's middle, a quarter of it cut off its left.
        project.clip_mut(&placed).unwrap().place = crate::project::Placement {
            x: 0.75,
            y: 0.25,
            scale: 0.5,
            crop: [0.25, 0.0, 0.0, 0.0],
        };
        let output = dir.join("out.mp4");
        let run = start(&project, &output, egui::Context::default()).unwrap();
        assert_eq!(run.result.recv().unwrap(), Ok(()));
        let frame = crate::ffmpeg::still(&output, 0.5, 160, 90, Default::default()).unwrap();
        let at = |x: f32, y: f32| {
            let i = ((y * 90.0) as usize * 160 + (x * 160.0) as usize) * 4;
            (frame.rgba[i], frame.rgba[i + 2])
        };
        let blueish = |(r, b): (u8, u8)| b > 150 && r < 100;
        let reddish = |(r, b): (u8, u8)| r > 150 && b < 100;
        assert!(
            blueish(at(0.85, 0.25)),
            "the placed picture: {:?}",
            at(0.85, 0.25)
        );
        assert!(
            reddish(at(0.25, 0.75)),
            "the track below shows around it: {:?}",
            at(0.25, 0.75)
        );
        assert!(
            reddish(at(0.56, 0.25)),
            "the cropped-off part shows what's below: {:?}",
            at(0.56, 0.25)
        );
        assert!(
            reddish(at(0.85, 0.75)),
            "below the placed picture: {:?}",
            at(0.85, 0.75)
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn slow_motion_and_pitch_reach_the_graph() {
        let mut project = Project::new("Slow");
        let video = project.add_media(media(MediaKind::Video, 10.0, true));
        let id = project.place(&video, None, 0.0).unwrap();
        project.set_speed(&id, 0.5);
        let clip = project.clip_mut(&id).unwrap();
        (clip.retime, clip.pitch_shift) = (crate::project::Retime::Blend, true);
        let args = arguments(&project, Path::new("o.mp4")).unwrap();
        let graph = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        let fps = project.fps;
        assert!(graph.contains(&format!("setpts=(PTS-STARTPTS)/0.5000,framerate=fps={fps},format=yuva420p")), "{graph}");
        assert!(graph.contains("aresample=48000,asetrate=24000,aresample=48000"), "{graph}");
        assert!(!graph.contains("atempo"), "pitch follows the speed, so no atempo: {graph}");
        project.clip_mut(&id).unwrap().retime = crate::project::Retime::Flow;
        let args = arguments(&project, Path::new("o.mp4")).unwrap();
        assert!(args.iter().any(|a| a.contains(&format!("minterpolate=fps={fps}:mi_mode=mci"))));
    }

    /// Needs FFmpeg on PATH: slowed down (each way of making frames) and sped up, a 30 fps clip exports at the
    /// project's 30 fps, for the length its speed gives it.
    #[test]
    fn speed_changes_keep_the_project_frame_rate() {
        let dir = std::env::temp_dir().join(format!("streamcuts-speed-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.mp4");
        assert!(command(&ffmpeg())
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=1", "-pix_fmt", "yuv420p"])
            .arg(&source)
            .status()
            .unwrap()
            .success());
        for (speed, retime, length) in [
            (0.5, crate::project::Retime::Nearest, 2.0),
            (0.5, crate::project::Retime::Blend, 2.0),
            (0.5, crate::project::Retime::Flow, 2.0),
            (2.0, crate::project::Retime::Nearest, 0.5),
        ] {
            let mut project = Project::new("Speed");
            (project.width, project.height, project.fps) = (160, 90, 30);
            project.even_loudness = false;
            let video = project.add_media(crate::ffmpeg::probe(&source).unwrap());
            let id = project.place(&video, None, 0.0).unwrap();
            project.set_speed(&id, speed);
            project.clip_mut(&id).unwrap().retime = retime;
            let output = dir.join(format!("out-{speed}-{retime:?}.mp4"));
            let run = start(&project, &output, egui::Context::default()).unwrap();
            assert_eq!(run.result.recv().unwrap(), Ok(()), "{speed} {retime:?}");
            let made = crate::ffmpeg::probe(&output).unwrap();
            assert!((made.frame_rate - 30.0).abs() < 0.01, "{speed} {retime:?}: {} fps", made.frame_rate);
            assert!((made.duration - length).abs() < 0.1, "{speed} {retime:?}: {} s", made.duration);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A check by hand on a real project: `STREAMCUTS_CHECK_PROJECT=<.streamcuts.json> STREAMCUTS_CHECK_OUT=<.mp4>
    /// cargo test renders_a_project_file -- --ignored` exports it at 480×270 and prints its length and loudness.
    #[test]
    #[ignore]
    fn renders_a_project_file() {
        let path = PathBuf::from(std::env::var("STREAMCUTS_CHECK_PROJECT").unwrap());
        let output = PathBuf::from(std::env::var("STREAMCUTS_CHECK_OUT").unwrap());
        let mut project = crate::storage::load(&path).unwrap();
        (project.width, project.height) = (480, 270);
        let length = project.duration();
        let run = start(&project, &output, egui::Context::default()).unwrap();
        assert_eq!(run.result.recv().unwrap(), Ok(()));
        let made = crate::ffmpeg::probe(&output).unwrap();
        println!("timeline {length:.1} s, rendered {:.1} s at {} fps, sound {}", made.duration, made.frame_rate, made.has_audio);
        assert!((made.duration - length).abs() < 1.0);
    }

    /// Needs FFmpeg on PATH: renders a real two-track timeline and checks the result plays for the right length.
    #[test]
    fn renders_a_part_of_the_timeline_with_ffmpeg() {
        // A 6-second clip whose picture tells the time (testsrc2's clock), with sound; the part from 2 s to 4.5 s.
        let dir = std::env::temp_dir().join(format!("streamcuts-part-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("clip.mp4");
        assert!(command(&ffmpeg())
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=6", "-f", "lavfi", "-i", "sine=duration=6", "-shortest", "-pix_fmt", "yuv420p"])
            .arg(&clip)
            .status()
            .unwrap()
            .success());
        let mut project = Project::new("Part");
        (project.width, project.height) = (320, 180);
        let video = project.add_media(crate::ffmpeg::probe(&clip).unwrap());
        project.place(&video, None, 0.0).unwrap();
        let part = project.excerpt(2.0, 4.5);
        let output = dir.join("part.mp4");
        let run = start(&part, &output, egui::Context::default()).unwrap();
        assert_eq!(run.result.recv().unwrap(), Ok(()));
        let rendered = crate::ffmpeg::probe(&output).unwrap();
        assert!((rendered.duration - 2.5).abs() < 0.15, "rendered {}", rendered.duration);
        assert!(rendered.has_audio);
        // Its first frame is the source's frame at 2 s, not its first.
        let frame = |path: &Path, at: &str| {
            let out = command(&ffmpeg())
                .args(["-v", "error", "-ss", at, "-i"])
                .arg(path)
                .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"])
                .output()
                .unwrap();
            out.stdout
        };
        let difference = |a: &[u8], b: &[u8]| a.iter().zip(b).map(|(x, y)| (*x as i32 - *y as i32).unsigned_abs() as u64).sum::<u64>() as f64 / a.len().max(1) as f64;
        let first = frame(&output, "0");
        assert!(difference(&first, &frame(&clip, "2.0")) < difference(&first, &frame(&clip, "0")), "starts at 2 s");
        assert!(difference(&first, &frame(&clip, "2.0")) < 6.0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_picture_with_no_background_shows_the_video_under_it() {
        let dir = std::env::temp_dir().join(format!("streamcuts-see-through-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("red.mp4");
        assert!(command(&ffmpeg())
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=2", "-pix_fmt", "yuv420p"])
            .arg(&clip)
            .status()
            .unwrap()
            .success());
        // A 320x180 PNG: nothing on its left half, solid green on its right.
        let picture = dir.join("half.png");
        image::RgbaImage::from_fn(320, 180, |x, _| if x < 160 { image::Rgba([0, 0, 0, 0]) } else { image::Rgba([0, 255, 0, 255]) })
            .save(&picture)
            .unwrap();
        let mut project = Project::new("See-through");
        (project.width, project.height) = (320, 180);
        let video = project.add_media(crate::ffmpeg::probe(&clip).unwrap());
        let png = project.add_media(crate::ffmpeg::probe(&picture).unwrap());
        project.place(&video, None, 0.0).unwrap();
        let top = project.add_track(TrackKind::Video);
        let still = project.place(&png, Some(top), 0.0).unwrap();
        project.clip_mut(&still).unwrap().place = crate::project::Placement::default();
        project.trim_end(&still, 2.0);
        let output = dir.join("out.mp4");
        let run = start(&project, &output, egui::Context::default()).unwrap();
        assert_eq!(run.result.recv().unwrap(), Ok(()));
        let out = command(&ffmpeg())
            .args(["-v", "error", "-ss", "1", "-i"])
            .arg(&output)
            .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .output()
            .unwrap()
            .stdout;
        let at = |x: usize| &out[(90 * 320 + x) * 3..(90 * 320 + x) * 3 + 3];
        assert!(at(60)[0] > 200 && at(60)[1] < 60, "the red video shows through: {:?}", at(60));
        assert!(at(260)[1] > 200 && at(260)[0] < 60, "the picture's green: {:?}", at(260));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_blur_on_a_track_leaves_the_graphic_above_it_sharp() {
        // Stripes on the bottom track; a striped graphic (a small PNG) on the track above, at the left. The blur is
        // the bottom track's, over the whole picture: the background goes soft, the graphic stays sharp.
        let dir = std::env::temp_dir().join(format!("streamcuts-track-blur-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("stripes.mp4");
        assert!(command(&ffmpeg())
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=320x180:r=30:d=2", "-vf", "drawgrid=w=8:h=180:t=4:c=black", "-pix_fmt", "yuv420p"])
            .arg(&clip)
            .status()
            .unwrap()
            .success());
        let graphic = dir.join("graphic.png");
        image::RgbaImage::from_fn(320, 180, |x, y| {
            if x < 120 && (40..140).contains(&y) {
                if (x / 6) % 2 == 0 { image::Rgba([255, 0, 0, 255]) } else { image::Rgba([255, 255, 0, 255]) }
            } else {
                image::Rgba([0, 0, 0, 0])
            }
        })
        .save(&graphic)
        .unwrap();
        let mut project = Project::new("Track blur");
        (project.width, project.height) = (320, 180);
        let video = project.add_media(crate::ffmpeg::probe(&clip).unwrap());
        let png = project.add_media(crate::ffmpeg::probe(&graphic).unwrap());
        let background = project.place(&video, None, 0.0).unwrap();
        let top = project.add_track(TrackKind::Video);
        let still = project.place(&png, Some(top), 0.0).unwrap();
        project.clip_mut(&still).unwrap().place = crate::project::Placement::default();
        project.trim_end(&still, 2.0);
        let bottom_track = project.tracks[project.find(&background).unwrap().track].id.clone();
        let id = project.add_blur(0.0, 2.0, Some(bottom_track));
        project.blur_mut(&id).unwrap().strength = 1.0;
        let output = dir.join("out.mp4");
        let run = start(&project, &output, egui::Context::default()).unwrap();
        assert_eq!(run.result.recv().unwrap(), Ok(()));
        let out = command(&ffmpeg())
            .args(["-v", "error", "-ss", "1", "-i"])
            .arg(&output)
            .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .output()
            .unwrap()
            .stdout;
        // The green channel swings with the graphic's red/yellow stripes and with the background's black/white ones.
        let swing = |from: usize, to: usize| {
            let row: Vec<i32> = (from..to).map(|x| out[(90 * 320 + x) * 3 + 1] as i32).collect();
            row.iter().max().unwrap() - row.iter().min().unwrap()
        };
        assert!(swing(20, 100) > 150, "the graphic stays sharp: {}", swing(20, 100));
        assert!(swing(180, 300) < 40, "the background is blurred: {}", swing(180, 300));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn renders_a_blurred_box_only_where_and_when_it_is() {
        // Sharp black and white stripes; the left half blurred from 1 s to 2 s of 3.
        let dir = std::env::temp_dir().join(format!("streamcuts-blur-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("stripes.mp4");
        assert!(command(&ffmpeg())
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=320x180:r=30:d=3", "-vf", "drawgrid=w=8:h=180:t=4:c=black", "-pix_fmt", "yuv420p"])
            .arg(&clip)
            .status()
            .unwrap()
            .success());
        let mut project = Project::new("Blur");
        (project.width, project.height) = (320, 180);
        let video = project.add_media(crate::ffmpeg::probe(&clip).unwrap());
        project.place(&video, None, 0.0).unwrap();
        let id = project.add_blur(1.0, 2.0, None);
        let blur = project.blur_mut(&id).unwrap();
        (blur.x, blur.y, blur.w, blur.h, blur.strength) = (0.0, 0.0, 0.5, 1.0, 1.0);
        let output = dir.join("blurred.mp4");
        let run = start(&project, &output, egui::Context::default()).unwrap();
        assert_eq!(run.result.recv().unwrap(), Ok(()));
        // How far a row of pixels swings between dark and light: stripes swing a lot, a blur hardly at all.
        let swing = |at: &str, from: usize, to: usize| {
            let out = command(&ffmpeg())
                .args(["-v", "error", "-ss", at, "-i"])
                .arg(&output)
                .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"])
                .output()
                .unwrap()
                .stdout;
            let row = &out[90 * 320..91 * 320];
            let part = &row[from..to];
            *part.iter().max().unwrap() as i32 - *part.iter().min().unwrap() as i32
        };
        assert!(swing("1.5", 20, 140) < 40, "blurred on the left at 1.5 s: {}", swing("1.5", 20, 140));
        assert!(swing("1.5", 180, 300) > 150, "sharp on the right at 1.5 s: {}", swing("1.5", 180, 300));
        assert!(swing("0.5", 20, 140) > 150, "sharp on the left before it: {}", swing("0.5", 20, 140));
        assert!(swing("2.5", 20, 140) > 150, "and after it: {}", swing("2.5", 20, 140));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn renders_a_timeline_with_ffmpeg() {
        let dir = std::env::temp_dir().join(format!("streamcuts-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("clip.mp4");
        let still = dir.join("still.png");
        assert!(
            command(&ffmpeg())
                .args([
                    "-v",
                    "error",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=320x180:rate=30:duration=2",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=duration=2",
                    "-shortest",
                    "-pix_fmt",
                    "yuv420p"
                ])
                .arg(&clip)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            command(&ffmpeg())
                .args([
                    "-v",
                    "error",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=orange:s=64x64",
                    "-frames:v",
                    "1"
                ])
                .arg(&still)
                .status()
                .unwrap()
                .success()
        );
        let mut project = Project::new("Render");
        project.width = 320;
        project.height = 180;
        let video = project.add_media(crate::ffmpeg::probe(&clip).unwrap());
        let picture = project.add_media(crate::ffmpeg::probe(&still).unwrap());
        let first = project.place(&video, None, 0.0).unwrap();
        (
            project.clip_mut(&first).unwrap().fade_in,
            project.clip_mut(&first).unwrap().fade_out,
        ) = (0.5, 0.5);
        // Its sound shaped and its color graded on the wheels: FFmpeg has to take those filters in the graph too.
        project.clip_mut(&first).unwrap().sound = crate::project::Sound {
            pan: -0.5,
            low: 4.0,
            mid: -2.0,
            high: 3.0,
        };
        project.clip_mut(&first).unwrap().grade.wheels.gain.r = 0.2;
        // Twice as fast: the 2-second clip covers 1 second, and FFmpeg has to take setpts and atempo.
        project.set_speed(&first, 2.0);
        let upper = project.add_track(TrackKind::Video);
        let still_clip = project.place(&picture, Some(upper), 1.0).unwrap();
        project.trim_end(&still_clip, 2.5);
        project.even_loudness = true;
        let caption = crate::project::Caption {
            id: new_id(),
            start: 0.2,
            end: 2.0,
            text: "Burned in".into(),
            words: Vec::new(),
            clip: None,
        };
        project.add_captions(0.0, 2.5, vec![caption]);
        assert!(
            arguments(&project, Path::new("o.mp4"))
                .unwrap()
                .iter()
                .any(|a| a.contains("subtitles=captions.ass:fontsdir=.,format=yuv420p[vout]"))
        );
        let output = dir.join("out.mp4");
        let run = start(&project, &output, egui::Context::default()).unwrap();
        assert_eq!(run.result.recv().unwrap(), Ok(()));
        let rendered = crate::ffmpeg::probe(&output).unwrap();
        assert!(
            (rendered.duration - 2.5).abs() < 0.15,
            "rendered {}",
            rendered.duration
        );
        assert!(rendered.has_audio && rendered.width == 320);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn presets_render_the_project_their_way() {
        let mut project = Project::new("Stream");
        project.even_loudness = false;
        let shorts = Preset::built_in()
            .into_iter()
            .find(|p| p.name == "YouTube Shorts")
            .unwrap();
        let queued = Queued::new(&project, &shorts);
        assert_eq!(
            (
                queued.project.width,
                queued.project.height,
                queued.project.fps,
                queued.project.even_loudness
            ),
            (1080, 1920, 60, true)
        );
        assert_eq!(
            (queued.name.as_str(), &queued.status),
            ("Stream - YouTube Shorts", &Status::Waiting)
        );
        assert_eq!(
            shorts.describe(),
            "1080×1920 · 60 fps · MP4 (H.264) · even loudness"
        );
        // Your own presets keep across runs.
        let dir = std::env::temp_dir().join(format!("streamcuts-presets-{}", new_id()));
        assert!(Preset::load(&dir).is_empty());
        let mine = Preset::of(&project, " Mine ");
        Preset::save(&dir, std::slice::from_ref(&mine)).unwrap();
        assert_eq!(Preset::load(&dir), vec![mine]);
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
        assert!(
            graph.contains(
                "force_original_aspect_ratio=increase,crop=1080:1920:(iw-ow)*0.250:(ih-oh)*0.500"
            ),
            "{graph}"
        );
        // The speed changes the frames' times first, then the project's frame rate is taken: exports stay at it.
        assert!(graph.contains("crop=1080:1920:(iw-ow)*0.250:(ih-oh)*0.500,eq=brightness=0.000:contrast=1.000:saturation=1.500,setpts=(PTS-STARTPTS)/2.0000,fps="), "{graph}");
        assert!(graph.contains("format=yuva420p,fade=t=in:st=0:d=0.500:alpha=1,fade=t=out:st=4.000:d=1.000:alpha=1"), "{graph}");
        assert!(graph.contains(
            "atempo=2.0000,afade=t=in:st=0:d=0.500,afade=t=out:st=4.000:d=1.000,adelay=0|0"
        ));
        assert!(
            args.join(" ").contains("-ss 0.000 -t 10.000 -i"),
            "the whole source still goes in"
        );
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

    #[test]
    fn every_format_renders_a_file_ffprobe_reads() {
        let dir = std::env::temp_dir().join(format!("streamcuts-formats-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("tone.mp4");
        assert!(
            command(&ffmpeg())
                .args([
                    "-v",
                    "error",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=red:s=64x64:r=30:d=1",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:duration=1",
                    "-shortest",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac"
                ])
                .arg(&source)
                .status()
                .unwrap()
                .success()
        );
        let mut project = Project::new("Formats");
        (project.width, project.height) = (64, 64);
        let id = project.add_media(crate::ffmpeg::probe(&source).unwrap());
        project.place(&id, None, 0.0).unwrap();
        for (format, video, audio) in [
            (ExportFormat::Prores, Some("prores"), "pcm_s16le"),
            (ExportFormat::Av1, Some("av1"), "aac"),
            (ExportFormat::Audio, None, "pcm_s16le"),
        ] {
            project.export_format = format;
            let output = dir.join(format!("out.{}", format.extension()));
            let run = start(&project, &output, egui::Context::default()).unwrap();
            assert_eq!(run.result.recv().unwrap(), Ok(()), "{format:?}");
            let probe = command(&crate::ffmpeg::ffprobe())
                .args([
                    "-v",
                    "error",
                    "-show_entries",
                    "stream=codec_name",
                    "-of",
                    "csv=p=0",
                ])
                .arg(&output)
                .output()
                .unwrap();
            let codecs = String::from_utf8_lossy(&probe.stdout)
                .split_whitespace()
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let expected: Vec<String> = video
                .into_iter()
                .chain([audio])
                .map(str::to_owned)
                .collect();
            assert_eq!(codecs, expected, "{format:?}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_crossfade_blends_two_neighboring_clips_in_the_render() {
        let dir = std::env::temp_dir().join(format!("streamcuts-crossfade-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let red = dir.join("red.mp4");
        let blue = dir.join("blue.mp4");
        for (path, color, duration) in [(&red, "red", "3"), (&blue, "blue", "2")] {
            assert!(
                command(&ffmpeg())
                    .args([
                        "-v",
                        "error",
                        "-y",
                        "-f",
                        "lavfi",
                        "-i",
                        &format!("color=c={color}:s=64x64:r=30:d={duration}"),
                        "-pix_fmt",
                        "yuv420p"
                    ])
                    .arg(path)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        let mut project = Project::new("Blend");
        project.width = 64;
        project.height = 64;
        let red_id = project.add_media(crate::ffmpeg::probe(&red).unwrap());
        let blue_id = project.add_media(crate::ffmpeg::probe(&blue).unwrap());
        let outgoing = project.place(&red_id, None, 0.0).unwrap();
        project.trim_end(&outgoing, 2.0);
        let incoming = project.place(&blue_id, None, 2.0).unwrap();
        project.set_crossfade(&incoming, 1.0);
        let output = dir.join("blend.mp4");
        let run = start(&project, &output, egui::Context::default()).unwrap();
        assert_eq!(run.result.recv().unwrap(), Ok(()));
        let frame =
            crate::ffmpeg::still(&output, 2.5, 64, 64, crate::project::Picture::default()).unwrap();
        let pixel = &frame.rgba[4 * (32 * 64 + 32)..][..4];
        assert!(
            pixel[0] > 45 && pixel[2] > 45,
            "both colors should be visible: {pixel:?}"
        );
        // The same as a blur-through: FFmpeg takes the blurs in the graph, and the plain colors still blend.
        project.clip_mut(&incoming).unwrap().transition = crate::project::Transition::BlurThrough;
        let args = arguments(&project, Path::new("o.mp4")).unwrap();
        let graph = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert_eq!(
            graph.matches("gblur=sigma=1.28:steps=3").count(),
            2,
            "{graph}"
        );
        let run = start(&project, &output, egui::Context::default()).unwrap();
        assert_eq!(run.result.recv().unwrap(), Ok(()));
        let frame =
            crate::ffmpeg::still(&output, 2.5, 64, 64, crate::project::Picture::default()).unwrap();
        let pixel = &frame.rgba[4 * (32 * 64 + 32)..][..4];
        assert!(
            pixel[0] > 45 && pixel[2] > 45,
            "both colors should be visible through the blur: {pixel:?}"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Every wipe, slide and dip renders halfway through as the preview draws it: the same parts of the frame show
    /// the outgoing red, the incoming blue, white, black or a mix.
    #[test]
    fn transitions_render_as_the_preview_draws_them() {
        use crate::project::Transition;
        let dir = std::env::temp_dir().join(format!("streamcuts-transitions-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (red, blue) = (dir.join("red.mp4"), dir.join("blue.mp4"));
        for (path, color) in [(&red, "red"), (&blue, "blue")] {
            assert!(command(&ffmpeg())
                .args(["-v", "error", "-y", "-f", "lavfi", "-i", &format!("color=c={color}:s=64x64:r=30:d=3"), "-pix_fmt", "yuv420p"])
                .arg(path)
                .status()
                .unwrap()
                .success());
        }
        let kind = |px: &[u8]| {
            let (r, g, b) = (px[0] as i32, px[1] as i32, px[2] as i32);
            if r > 190 && g > 190 && b > 190 {
                "white"
            } else if r < 50 && g < 50 && b < 50 {
                "black"
            } else if r > b + 80 {
                "red"
            } else if b > r + 80 {
                "blue"
            } else {
                "mix"
            }
        };
        let points = [(10, 10), (54, 10), (10, 54), (54, 54), (40, 22), (22, 40)];
        let mut checked = 0;
        for transition in Transition::ALL.into_iter().filter(|t| t.xfade().is_some()) {
            let mut project = Project::new("Wipes");
            (project.width, project.height) = (64, 64);
            let red_id = project.add_media(crate::ffmpeg::probe(&red).unwrap());
            let blue_id = project.add_media(crate::ffmpeg::probe(&blue).unwrap());
            let outgoing = project.place(&red_id, None, 0.0).unwrap();
            project.trim_end(&outgoing, 2.0);
            let incoming = project.place(&blue_id, None, 2.0).unwrap();
            project.set_crossfade(&incoming, 1.0);
            project.clip_mut(&incoming).unwrap().transition = transition;
            let output = dir.join(format!("{}.mp4", transition.key()));
            let run = start(&project, &output, egui::Context::default()).unwrap();
            assert_eq!(run.result.recv().unwrap(), Ok(()), "{transition:?}");
            let rendered = crate::ffmpeg::still(&output, 2.5, 64, 64, crate::project::Picture::default()).unwrap();
            let solid = |color: [u8; 4]| crate::ffmpeg::Frame { time: 0.0, size: [64, 64], rgba: color.repeat(64 * 64) };
            let drawn = crate::ffmpeg::crossfade_frames(&solid([255, 0, 0, 255]), &solid([0, 0, 255, 255]), 0.5, transition);
            let at = |frame: &crate::ffmpeg::Frame, (x, y): (usize, usize)| kind(&frame.rgba[4 * (y * 64 + x)..][..4]);
            // Red and blue against each other, and how bright: within a little of each other at every point (a soft
            // edge's gradient differs by a frame's worth of progress).
            let measure = |frame: &crate::ffmpeg::Frame, (x, y): (usize, usize)| {
                let px = &frame.rgba[4 * (y * 64 + x)..][..4];
                (px[2] as i32 - px[0] as i32, (px[0] as i32 + px[1] as i32 + px[2] as i32) / 3)
            };
            for &point in &points {
                let (e, d) = (measure(&rendered, point), measure(&drawn, point));
                assert!(
                    (e.0 - d.0).abs() <= 70 && (e.1 - d.1).abs() <= 50,
                    "{transition:?} halfway at {point:?}: export {} {e:?}, preview {} {d:?}",
                    at(&rendered, point),
                    at(&drawn, point)
                );
            }
            // Before it starts, only the outgoing clip; after it, only the incoming one.
            let before = crate::ffmpeg::still(&output, 1.9, 64, 64, crate::project::Picture::default()).unwrap();
            let after = crate::ffmpeg::still(&output, 3.1, 64, 64, crate::project::Picture::default()).unwrap();
            assert_eq!(at(&before, (32, 32)), "red", "{transition:?} before");
            assert_eq!(at(&after, (32, 32)), "blue", "{transition:?} after");
            checked += 1;
        }
        assert_eq!(checked, 14);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod see_through_bars {
    use super::*;
    use crate::project::TrackKind;

    /// A picture of another shape (a portrait 4:5 PNG with no background, dropped over video in a 16:9 and a 9:16
    /// project) is fitted with see-through bars: the video under it shows there, in exports and in the preview.
    #[test]
    fn a_fitted_picture_of_another_shape_leaves_the_video_under_it_showing() {
        let dir = std::env::temp_dir().join(format!("streamcuts-bars-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let picture = dir.join("portrait.png");
        image::RgbaImage::from_pixel(1080, 1350, image::Rgba([0, 0, 0, 0])).save(&picture).unwrap();
        for (w, h) in [(1920u32, 1080u32), (1080, 1920)] {
            // A red video the project's own shape, so it covers the whole frame.
            let clip = dir.join(format!("red-{w}.mp4"));
            let size = format!("color=c=red:s={}x{}:r=30:d=3", w / 4, h / 4);
            assert!(command(&ffmpeg()).args(["-v", "error", "-y", "-f", "lavfi", "-i", &size, "-pix_fmt", "yuv420p"]).arg(&clip).status().unwrap().success());
            let mut project = Project::new("Bars");
            (project.width, project.height) = (w, h);
            let video = project.add_media(crate::ffmpeg::probe(&clip).unwrap());
            let pic = project.add_media(crate::ffmpeg::probe(&picture).unwrap());
            project.place(&video, None, 0.0).unwrap();
            let top = project.add_track(TrackKind::Video);
            let (still, _) = project.place_at(&pic, Some(top), 0.5).unwrap();
            assert_eq!(project.layers_at(1.0).len(), 2, "the video under it is drawn too");
            // The preview's still of the picture: see-through in its bars as in its middle.
            let (dw, dh) = crate::preview::decode_size(&project);
            let frame = crate::ffmpeg::still(&picture, 0.0, dw, dh, project.clip(&still).unwrap().picture()).unwrap();
            let alpha = |x: u32, y: u32| frame.rgba[((y * dw + x) * 4 + 3) as usize];
            assert_eq!((alpha(dw / 2, dh / 2), alpha(2, 2)), (0, 0), "{w}x{h}");
            let output = dir.join(format!("out-{w}.mp4"));
            let run = start(&project, &output, egui::Context::default()).unwrap();
            assert_eq!(run.result.recv().unwrap(), Ok(()));
            let out = command(&ffmpeg()).args(["-v", "error", "-ss", "1", "-i"]).arg(&output).args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).output().unwrap().stdout;
            let px = |x: u32, y: u32| { let i = ((y * w + x) * 3) as usize; [out[i], out[i + 1], out[i + 2]] };
            for (x, y) in [(w / 2, h / 2), (8, 8), (w - 8, h - 8)] {
                let p = px(x, y);
                assert!(p[0] > 200 && p[1] < 60, "{w}x{h} at {x},{y}: {p:?}");
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
