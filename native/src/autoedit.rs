//! Carries out Codex's edit plan on the project: what it wants fetched first (`wants`), then everything in one go
//! (`apply`): overlays and sounds where it said, transitions, titles, captions, punch-ins, volume and speed changes,
//! and the cuts last (latest first, so its times stay right), then a transition on every bare cut of the main video.

use crate::codex::{Kind, Plan};
use crate::project::{Caption, Media, MediaKind, Placement, Project, TrackKind, Transition, Word, new_id};
use crate::speech::Spoken;
use crate::stock::Want;
use std::collections::HashMap;

/// What one of the plan's operations needs fetched: its index, the kind of thing and the words to find it by.
pub fn wants(plan: &Plan) -> Vec<(usize, Want, String)> {
    plan.operations
        .iter()
        .enumerate()
        .filter_map(|(i, op)| {
            let query = op.query.clone().filter(|q| !q.trim().is_empty())?;
            let want = match op.kind {
                Kind::Gif => Want::Gif { sticker: op.sticker.unwrap_or(false) },
                Kind::Picture => Want::Picture,
                Kind::StockVideo => Want::StockVideo,
                Kind::Sound => Want::Sound {
                    longest: match (op.start, op.end) {
                        (Some(s), Some(e)) if e > s => (e - s).max(2.0),
                        _ => 12.0,
                    },
                },
                _ => return None,
            };
            Some((i, want, query))
        })
        .collect()
}

/// What happened: lines for the person, problems, credits, and the ids of what was added (to select).
#[derive(Debug, Default)]
pub struct Report {
    pub done: Vec<String>,
    pub problems: Vec<String>,
    pub credits: Vec<String>,
    pub added: Vec<String>,
}

/// The video track the video is mostly on: the unlocked one with the most clip time (the lowest such, when tied).
pub fn main_track(project: &Project) -> Option<usize> {
    project
        .tracks
        .iter()
        .enumerate()
        .filter(|(_, t)| t.kind == TrackKind::Video && !t.locked)
        .map(|(i, t)| (i, t.clips.iter().map(|c| c.duration).sum::<f64>()))
        .filter(|(_, time)| *time > 0.0)
        .max_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)))
        .map(|(i, _)| i)
}

/// Where an overlay of `media` goes so it's `size` of the frame's width with its middle at `x`, `y`, kept in the frame:
/// the framed picture's padding (it's fitted into the frame's shape first) cut off, so no bars show.
fn overlay_place(project: &Project, media: &Media, x: f32, y: f32, size: f32) -> Placement {
    let frame = project.width as f32 / project.height.max(1) as f32;
    let own = if media.height > 0 { media.width as f32 / media.height as f32 } else { frame };
    let size = size.clamp(0.08, 1.0);
    let mut crop = [0.0; 4];
    // A hair more than the padding, so no line of it is left.
    if own < frame {
        let side = (1.0 - own / frame) / 2.0 + 0.003;
        crop[0] = side;
        crop[2] = side;
    } else {
        let side = (1.0 - frame / own) / 2.0 + 0.003;
        crop[1] = side;
        crop[3] = side;
    }
    let tall = size * frame / own;
    let x = x.clamp(size / 2.0, 1.0 - size / 2.0);
    let y = y.clamp((tall / 2.0).min(0.5), (1.0 - tall / 2.0).max(0.5));
    Placement { x, y, scale: size / (1.0 - crop[0] - crop[2]), crop }.tidy()
}

/// A track of `kind` that's free from `start` to `end` and isn't locked: for video, one above `main` (in front of the
/// video); a new one when there's none.
fn free_track(project: &mut Project, kind: TrackKind, start: f64, end: f64, main: Option<usize>) -> usize {
    let free = |p: &Project, i: usize| {
        let t = &p.tracks[i];
        t.kind == kind && !t.locked && !t.clips.iter().any(|c| c.start < end - 1e-6 && c.end() > start + 1e-6)
    };
    let candidates: Vec<usize> = match (kind, main) {
        (TrackKind::Video, Some(main)) => (0..main).rev().collect(),
        (TrackKind::Video, None) => (0..project.tracks.len()).collect(),
        // Sounds go on audio tracks after the first (which usually has the video's own sound).
        (TrackKind::Audio, _) => {
            let audio: Vec<usize> = (0..project.tracks.len()).filter(|&i| project.tracks[i].kind == TrackKind::Audio).collect();
            audio.into_iter().skip(1).collect()
        }
    };
    if let Some(i) = candidates.into_iter().find(|&i| free(project, i)) {
        return i;
    }
    project.add_track(kind)
}

/// Lines of captions from the words said between `from` and `to`: a few words at a time, broken at pauses.
fn caption_lines(words: &[Spoken], from: f64, to: f64) -> Vec<Caption> {
    let mut out: Vec<Caption> = Vec::new();
    for w in words.iter().filter(|w| w.start >= from - 1e-6 && w.end <= to + 1e-6) {
        let word = Word { text: w.text.clone(), start: w.start, end: w.end };
        match out.last_mut() {
            Some(line) if w.start - line.end < 0.6 && line.words.len() < 6 && w.end - line.start < 3.0 => {
                line.end = w.end;
                line.text.push(' ');
                line.text.push_str(&w.text);
                line.words.push(word);
            }
            _ => out.push(Caption { id: new_id(), start: w.start, end: w.end, text: w.text.clone(), words: vec![word], clip: None }),
        }
    }
    // Each line stays up until the next (or a moment after its last word).
    for i in 0..out.len() {
        let next = out.get(i + 1).map_or(f64::INFINITY, |n| n.start);
        out[i].end = (out[i].end + 0.4).min(next);
    }
    out
}

fn clock(t: f64) -> String {
    let t = t.max(0.0);
    format!("{}:{:04.1}", (t / 60.0) as u64, t % 60.0)
}

/// Carries out the plan. `fetched` has, for each operation that needed something, the media to add (already probed)
/// and its credit, or why it couldn't be had. `words` is what's said, for captions.
pub fn apply(
    project: &mut Project,
    plan: &Plan,
    fetched: &HashMap<usize, Result<(Media, String), String>>,
    words: &[Spoken],
) -> Report {
    let mut report = Report::default();
    let main_id = main_track(project).map(|i| project.tracks[i].id.clone());
    let main = |p: &Project| main_id.as_ref().and_then(|id| p.tracks.iter().position(|t| &t.id == id));
    let mut counts: HashMap<&'static str, usize> = HashMap::new();
    let mut count = |what: &'static str| *counts.entry(what).or_default() += 1;
    let mut cuts: Vec<(f64, f64)> = Vec::new();
    for (index, op) in plan.operations.iter().enumerate() {
        let problem = |report: &mut Report, text: String| report.problems.push(text);
        match op.kind {
            Kind::Cut => match (op.start, op.end) {
                (Some(s), Some(e)) if e > s => cuts.push((s, e)),
                _ => problem(&mut report, "A cut had no stretch to take out.".into()),
            },
            Kind::Gif | Kind::Picture | Kind::StockVideo | Kind::Sound => {
                let Some(result) = fetched.get(&index) else {
                    problem(&mut report, format!("Nothing to search for at {}.", clock(op.start.unwrap_or(0.0))));
                    continue;
                };
                let (media, credit) = match result {
                    Ok(found) => found.clone(),
                    Err(e) => {
                        problem(&mut report, e.clone());
                        continue;
                    }
                };
                let start = op.start.unwrap_or(0.0).max(0.0);
                let natural = match media.kind {
                    MediaKind::Image if media.loop_length().is_some() => 3.0,
                    MediaKind::Image => 3.0,
                    _ => media.duration,
                };
                let end = op.end.filter(|e| *e > start + 0.1).unwrap_or(start + natural);
                let length = match media.kind {
                    // A video or sound can't play longer than it is (an animated GIF loops, a picture holds).
                    MediaKind::Video | MediaKind::Audio if media.loop_length().is_none() => (end - start).min(media.duration),
                    _ => end - start,
                };
                if credit != "" && !report.credits.contains(&credit) {
                    report.credits.push(credit.clone());
                }
                let id = project.add_media(media.clone());
                let is_sound = op.kind == Kind::Sound;
                let kind = if is_sound { TrackKind::Audio } else { TrackKind::Video };
                let track = free_track(project, kind, start, start + length, main(project));
                let Some(clip_id) = project.place(&id, Some(track), start) else {
                    problem(&mut report, format!("Couldn't place {}.", media.name));
                    continue;
                };
                let place = overlay_place(project, &media, op.x.unwrap_or(0.78), op.y.unwrap_or(0.25), op.size.unwrap_or(0.3));
                if let Some(clip) = project.clip_mut(&clip_id) {
                    clip.start = start;
                    clip.duration = length.max(0.1);
                    if is_sound {
                        clip.volume = op.value.unwrap_or(0.6).clamp(0.0, 3.0) as f32;
                        clip.fade_out = (clip.duration * 0.15).min(0.3);
                    } else {
                        // Stock video plays silently under the talking.
                        if op.kind == Kind::StockVideo {
                            clip.volume = 0.0;
                        }
                        clip.place = place;
                        if op.size.is_some_and(|s| s >= 0.98) {
                            clip.place = Placement::default();
                            clip.framing = crate::project::Framing::Fill { x: 0.5, y: 0.5 };
                        }
                        clip.fade_in = 0.12f64.min(clip.duration / 4.0);
                        clip.fade_out = 0.12f64.min(clip.duration / 4.0);
                    }
                }
                report.added.push(clip_id);
                count(match op.kind {
                    Kind::Gif => "gif",
                    Kind::Picture => "picture",
                    Kind::StockVideo => "stock video",
                    _ => "sound",
                });
            }
            Kind::Remove => match op.clip.as_deref() {
                Some(id) if project.delete(&[id.to_owned()]) > 0 => count("removed"),
                _ => problem(&mut report, format!("There's no {} to remove.", op.clip.as_deref().unwrap_or("clip"))),
            },
            Kind::Move => {
                let (Some(id), Some(start)) = (op.clip.as_deref(), op.start) else {
                    problem(&mut report, "A move had no clip or time.".into());
                    continue;
                };
                if let Some(title) = project.title_mut(id) {
                    let length = title.end - title.start;
                    title.start = start.max(0.0);
                    title.end = title.start + length;
                    count("moved");
                } else if let Some(at) = project.find(id) {
                    if project.move_clip(id, start, at.track) {
                        count("moved");
                    } else {
                        problem(&mut report, format!("No room to move {id} to {}.", clock(start)));
                    }
                } else {
                    problem(&mut report, format!("There's no {id} to move."));
                }
            }
            Kind::Transition => {
                let Some(at) = op.start else {
                    problem(&mut report, "A transition had no time.".into());
                    continue;
                };
                let style = op.style.as_deref().and_then(Transition::from_key).unwrap_or_default();
                // The clip that starts at that cut on a video track, right after another.
                let incoming = project
                    .tracks
                    .iter()
                    .filter(|t| t.kind == TrackKind::Video && !t.locked)
                    .flat_map(|t| t.clips.iter())
                    .filter(|c| (c.start - at).abs() < 0.25 && project.left_neighbor(&c.id).is_some())
                    .min_by(|a, b| (a.start - at).abs().total_cmp(&(b.start - at).abs()))
                    .map(|c| c.id.clone());
                match incoming {
                    Some(id) if project.crossfade_limit(&id) >= 0.1 => {
                        project.set_crossfade(&id, op.value.unwrap_or(0.5).clamp(0.1, 1.5));
                        if let Some(clip) = project.clip_mut(&id) {
                            clip.transition = style;
                        }
                        count("transition");
                    }
                    Some(_) => problem(&mut report, format!("No footage left past the cut at {} for a transition.", clock(at))),
                    None => problem(&mut report, format!("No cut at {} for a transition.", clock(at))),
                }
            }
            Kind::Title => {
                // The text, or (if Codex put it there instead) the query.
                let text = op.text.clone().or(op.query.clone()).filter(|t| !t.trim().is_empty());
                let (Some(text), Some(start)) = (text, op.start) else {
                    problem(&mut report, "A title had no text or time.".into());
                    continue;
                };
                let id = project.add_title(start.max(0.0));
                if let Some(title) = project.title_mut(&id) {
                    title.text = text;
                    title.end = op.end.filter(|e| *e > start + 0.2).unwrap_or(start + 3.0);
                    title.x = op.x.unwrap_or(0.5).clamp(0.05, 0.95);
                    title.y = op.y.unwrap_or(0.2).clamp(0.05, 0.95);
                    title.size = op.size.unwrap_or(0.08).clamp(0.03, 0.2);
                }
                report.added.push(id);
                count("title");
            }
            Kind::Volume | Kind::Speed => {
                let (Some(id), Some(value)) = (op.clip.as_deref(), op.value) else {
                    problem(&mut report, "A volume or speed change had no clip or value.".into());
                    continue;
                };
                if project.clip(id).is_none() {
                    problem(&mut report, format!("There's no clip {id}."));
                } else if op.kind == Kind::Volume {
                    project.clip_mut(id).unwrap().volume = value.clamp(0.0, 3.0) as f32;
                    count("volume");
                } else {
                    project.set_speed_ripple(id, value);
                    count("speed");
                }
            }
            Kind::Zoom => {
                let (Some(start), Some(end)) = (op.start, op.end.filter(|e| Some(*e) > op.start)) else {
                    problem(&mut report, "A zoom had no stretch.".into());
                    continue;
                };
                let Some(track) = main(project) else { continue };
                let zoom = op.value.unwrap_or(1.3).clamp(1.05, 2.5) as f32;
                // The main video is cut at the zoom's ends; the pieces between are blown up around the point.
                for t in [start, end] {
                    let across: Vec<String> = project.tracks[track].clips.iter().filter(|c| c.start < t - 0.05 && c.end() > t + 0.05).map(|c| c.id.clone()).collect();
                    for id in across {
                        project.split(&id, t);
                    }
                }
                let (fx, fy) = (op.x.unwrap_or(0.5), op.y.unwrap_or(0.5));
                let place = Placement {
                    x: (0.5 + (0.5 - fx) * zoom).clamp(1.0 - zoom / 2.0, zoom / 2.0),
                    y: (0.5 + (0.5 - fy) * zoom).clamp(1.0 - zoom / 2.0, zoom / 2.0),
                    scale: zoom,
                    crop: [0.0; 4],
                };
                let mut any = false;
                for clip in project.tracks[track].clips.iter_mut().filter(|c| c.start >= start - 0.06 && c.end() <= end + 0.06) {
                    clip.place = place;
                    any = true;
                }
                if any { count("zoom") } else { problem(&mut report, format!("Nothing to zoom at {}.", clock(start))) }
            }
            Kind::Captions => {
                let (from, to) = (op.start.unwrap_or(0.0), op.end.unwrap_or(project.duration()));
                let lines = caption_lines(words, from, to);
                if lines.is_empty() {
                    problem(&mut report, "There are no words there for captions (refresh the transcript?).".into());
                } else {
                    let n = lines.len();
                    project.add_captions(from, to, lines);
                    report.done.push(format!("Put {n} lines of captions on."));
                }
            }
            Kind::Marker => {
                project.add_marker(op.start.unwrap_or(0.0), op.text.as_deref().unwrap_or(""));
                count("marker");
            }
        }
    }
    // Cuts last, latest first, so the earlier times stay where they were.
    cuts.sort_by(|a, b| b.0.total_cmp(&a.0));
    let mut taken = 0.0;
    let mut last_start = f64::INFINITY;
    let mut made = 0;
    for (s, e) in cuts {
        // Overlapping cuts become one.
        let e = e.min(last_start);
        if e - s > 0.01 && project.remove_range(s, e) {
            taken += e - s;
            made += 1;
        }
        last_start = last_start.min(s);
    }
    if made > 0 {
        report.done.push(format!("Cut {made} stretch{} ({taken:.1} s in all).", if made == 1 { "" } else { "es" }));
    }
    // A transition on every cut of the main video that has none and nothing playing over it.
    if let Some(bare) = &plan.transition_for_bare_cuts {
        let style = Transition::from_key(&bare.style).unwrap_or_default();
        let n = transitions_on_bare_cuts(project, style, bare.seconds.clamp(0.1, 1.5));
        if n > 0 {
            report.done.push(format!("Put a {} on {n} cut{} that had nothing.", style.label().to_lowercase(), if n == 1 { "" } else { "s" }));
        }
    }
    for (what, n) in [("gif", "GIF"), ("picture", "picture"), ("stock video", "stock video"), ("sound", "sound"), ("title", "title"), ("transition", "transition"), ("zoom", "zoom"), ("marker", "marker")] {
        if let Some(&count) = counts.get(what) {
            report.done.push(format!("Added {count} {n}{}.", if count == 1 { "" } else { "s" }));
        }
    }
    for (what, text) in [("removed", "Removed"), ("moved", "Moved"), ("volume", "Changed the volume of"), ("speed", "Changed the speed of")] {
        if let Some(&count) = counts.get(what) {
            report.done.push(format!("{text} {count} thing{}.", if count == 1 { "" } else { "s" }));
        }
    }
    report
}

/// Puts `style` on every cut of the main video track (two clips meeting) that has no transition and nothing on a video
/// track above it playing across it, where there's footage for it. Returns how many.
pub fn transitions_on_bare_cuts(project: &mut Project, style: Transition, seconds: f64) -> usize {
    let Some(main) = main_track(project) else { return 0 };
    let cuts: Vec<(String, f64)> = project.tracks[main]
        .clips
        .windows(2)
        .filter(|pair| (pair[0].end() - pair[1].start).abs() < 0.002)
        .map(|pair| (pair[1].id.clone(), pair[1].start))
        .collect();
    let mut made = 0;
    for (id, at) in cuts {
        if project.crossfade_before(&id).is_some() {
            continue;
        }
        // Something showing on a video track above, just before the cut and just after it (one clip or two).
        let showing = |t: f64| {
            project.tracks[..main]
                .iter()
                .filter(|track| track.kind == TrackKind::Video && !track.hidden)
                .flat_map(|track| track.clips.iter())
                .any(|c| c.start <= t && c.end() > t)
        };
        let covered = showing(at - 0.05) && showing(at + 0.05);
        if covered || project.crossfade_limit(&id) < 0.1 {
            continue;
        }
        project.set_crossfade(&id, seconds);
        if let Some(clip) = project.clip_mut(&id) {
            clip.transition = style;
        }
        made += 1;
    }
    made
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex::{BareCuts, Op};
    use crate::project::Attributes;

    fn media(kind: MediaKind, duration: f64, (width, height): (u32, u32)) -> Media {
        Media {
            id: new_id(),
            path: format!("C:/m/{}.mp4", new_id()).into(),
            name: "m".into(),
            kind,
            duration,
            width,
            height,
            has_audio: kind != MediaKind::Image,
            frame_rate: 30.0,
            attributes: Attributes::default(),
        }
    }

    fn op(kind: Kind) -> Op {
        Op { kind, clip: None, start: None, end: None, query: None, text: None, style: None, x: None, y: None, size: None, value: None, sticker: None }
    }

    /// A 30 s video cut into three 10 s pieces of a 60 s source (so there's footage past each cut for transitions).
    fn three_pieces() -> (Project, Vec<String>) {
        let mut project = Project::new("Edit");
        let footage = project.add_media(media(MediaKind::Video, 60.0, (1920, 1080)));
        let mut ids = Vec::new();
        for i in 0..3 {
            let id = project.place(&footage, Some(0), 100.0 + i as f64 * 70.0).unwrap();
            let clip = project.clip_mut(&id).unwrap();
            (clip.start, clip.source_in, clip.duration) = (i as f64 * 10.0, i as f64 * 20.0, 10.0);
            ids.push(id);
        }
        project.tracks[0].clips.sort_by(|a, b| a.start.total_cmp(&b.start));
        (project, ids)
    }

    #[test]
    fn a_plan_edits_the_project() {
        let (mut project, ids) = three_pieces();
        let gif = media(MediaKind::Image, 1.0, (480, 270));
        let boom = media(MediaKind::Audio, 2.0, (0, 0));
        let plan = Plan {
            reply: String::new(),
            operations: vec![
                Op { start: Some(4.0), end: Some(7.0), query: Some("wow".into()), x: Some(0.8), y: Some(0.2), size: Some(0.3), ..op(Kind::Gif) },
                Op { start: Some(15.0), query: Some("boom".into()), value: Some(0.5), ..op(Kind::Sound) },
                Op { start: Some(20.0), style: Some("wipe-left".into()), value: Some(0.5), ..op(Kind::Transition) },
                Op { start: Some(1.0), end: Some(3.0), text: Some("Day one".into()), ..op(Kind::Title) },
                Op { start: Some(22.0), end: Some(25.0), ..op(Kind::Cut) },
                Op { start: Some(5.0), end: Some(6.0), ..op(Kind::Cut) },
            ],
            transition_for_bare_cuts: Some(BareCuts { style: "dip-to-black".into(), seconds: 0.4 }),
        };
        let fetched = HashMap::from([(0, Ok((gif, "GIPHY".into()))), (1, Ok((boom, String::new())))]);
        let report = apply(&mut project, &plan, &fetched, &[]);
        assert!(report.problems.is_empty(), "{report:?}");
        assert_eq!(report.credits, ["GIPHY"]);
        // Two cuts: 4 s gone; the GIF (4-7) lost the second at 5-6, so it's 4-6; the sound at 15 is now at 14.
        assert_eq!(project.duration(), 26.0);
        // (The cut went through it, so it's in two pieces that play on from each other.)
        let overlay_track = &project.tracks[project.find(&report.added[0]).unwrap().track];
        let spans: Vec<(f64, f64)> = overlay_track.clips.iter().map(|c| (c.start, c.end())).collect();
        assert_eq!(spans, [(4.0, 5.0), (5.0, 6.0)]);
        let overlay = project.clip(&report.added[0]).unwrap();
        assert!(project.find(&report.added[0]).unwrap().track < project.find(&ids[0]).unwrap().track, "in front of the video");
        assert!((overlay.place.shown()[2] - overlay.place.shown()[0] - 0.3).abs() < 0.01, "a third of the frame wide: {:?}", overlay.place);
        let sound = project.clip(&report.added[1]).unwrap();
        assert_eq!((sound.start, sound.volume), (14.0, 0.5));
        // The cut at 20 (now 19) has its wipe; the one at 10 (now 9) got the dip to black, as did the cut the 5-6 cut
        // made inside the first piece.
        let main = &project.tracks[main_track(&project).unwrap()].clips;
        let ins: Vec<(f64, Option<Transition>)> = main.iter().skip(1).map(|c| (c.start, project.crossfade_before(&c.id).map(|_| c.transition))).collect();
        assert_eq!(ins.len(), 4, "{ins:?}");
        assert!(ins.contains(&(19.0, Some(Transition::WipeLeft))), "{ins:?}");
        assert!(ins.contains(&(9.0, Some(Transition::DipToBlack))), "{ins:?}");
        assert_eq!(project.titles[0].text, "Day one");
        // The new cut at 5 (inside the GIF's time) has the GIF over it, so it stays bare.
        assert!(ins.contains(&(5.0, None)), "{ins:?}");
    }

    #[test]
    fn what_cant_be_done_is_said() {
        let (mut project, _) = three_pieces();
        let plan = Plan {
            reply: String::new(),
            operations: vec![
                Op { start: Some(3.0), query: Some("nothing".into()), ..op(Kind::Picture) },
                Op { start: Some(4.0), style: Some("dissolve".into()), ..op(Kind::Transition) },
                Op { clip: Some("nope".into()), value: Some(2.0), ..op(Kind::Volume) },
            ],
            transition_for_bare_cuts: None,
        };
        let fetched = HashMap::from([(0, Err("Pixabay has no picture for \"nothing\".".to_string()))]);
        let report = apply(&mut project, &plan, &fetched, &[]);
        assert_eq!(report.problems.len(), 3, "{report:?}");
        assert!(report.problems[1].contains("No cut at"));
    }

    #[test]
    fn captions_and_zooms() {
        let (mut project, _) = three_pieces();
        let words: Vec<Spoken> = ["one", "two", "three", "four"].iter().enumerate()
            .map(|(i, w)| Spoken { start: 1.0 + i as f64 * 0.4, end: 1.3 + i as f64 * 0.4, text: w.to_string() })
            .collect();
        let plan = Plan {
            reply: String::new(),
            operations: vec![
                Op { ..op(Kind::Captions) },
                Op { start: Some(12.0), end: Some(14.0), value: Some(1.5), x: Some(0.5), y: Some(0.5), ..op(Kind::Zoom) },
            ],
            transition_for_bare_cuts: None,
        };
        let report = apply(&mut project, &plan, &HashMap::new(), &words);
        assert!(report.problems.is_empty(), "{report:?}");
        assert_eq!(project.captions.len(), 1);
        assert_eq!(project.captions[0].text, "one two three four");
        let zoomed: Vec<(f64, f64)> = project.tracks[0].clips.iter().filter(|c| c.place.scale > 1.0).map(|c| (c.start, c.end())).collect();
        assert_eq!(zoomed, [(12.0, 14.0)]);
    }

    #[test]
    fn overlays_show_without_bars_and_stay_in_the_frame() {
        let project = Project::new("Frame");
        let square = media(MediaKind::Image, 1.0, (500, 500));
        let place = overlay_place(&project, &square, 0.99, 0.5, 0.3);
        let [l, t, r, b] = place.shown();
        assert!((r - l - 0.3).abs() < 0.01, "{place:?}");
        assert!(r <= 1.0 + 1e-3 && l >= 0.0, "kept in the frame: {l}..{r}");
        // A square is as tall as it is wide on a 16:9 frame: 0.3 of the width is 0.53 of the height.
        assert!((b - t - 0.3 * 16.0 / 9.0).abs() < 0.02, "{place:?}");
    }
}
