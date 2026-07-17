import { Command, type CommandResult } from "@/commands/base-command";
import type { SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import { isRetimableElement } from "@/timeline";
import { EditorCore } from "@/core";
import { generateUUID } from "@/utils/id";
import { getSourceSpanAtClipTime } from "@/retime";
import {
	type MediaTime,
	TICKS_PER_SECOND,
	roundMediaTime,
} from "@/wasm";
import type { SilentTimeRange } from "@/media/silence-detection";

// Produce sub-elements for one element by punching out the given sorted,
// non-overlapping ranges (all in MediaTime ticks). Returns an empty array
// if the element itself is fully contained in a silent range.
function splitElementAroundRanges(
	element: TimelineElement,
	ranges: SilentTimeRange[],
): TimelineElement[] {
	const eStart = element.startTime;
	const eEnd = element.startTime + element.duration;

	// Ranges that overlap with this element
	const overlapping = ranges.filter((r) => r.end > eStart && r.start < eEnd);
	if (overlapping.length === 0) return [element];

	const retime = isRetimableElement(element) ? element.retime : undefined;
	const totalSourceSpanSecs = getSourceSpanAtClipTime({
		clipTime: element.duration / TICKS_PER_SECOND,
		retime,
	});
	const totalSourceSpanTicks = roundMediaTime({
		time: totalSourceSpanSecs * TICKS_PER_SECOND,
	});

	// Helper: source span (in ticks) from element start up to clipTime (in ticks from eStart)
	const sourceSpanUpTo = (clipTimeTicks: MediaTime): MediaTime =>
		roundMediaTime({
			time:
				getSourceSpanAtClipTime({
					clipTime: clipTimeTicks / TICKS_PER_SECOND,
					retime,
				}) * TICKS_PER_SECOND,
		});

	const makeSubclip = (
		clipStart: MediaTime, // absolute timeline ticks
		clipEnd: MediaTime,
	): TimelineElement | null => {
		const dur = clipEnd - clipStart;
		if (dur <= 0) return null;

		const relStart = (clipStart - eStart) as MediaTime;
		const relEnd = (clipEnd - eStart) as MediaTime;

		const sourceToStart = sourceSpanUpTo(relStart);
		const sourceToEnd = sourceSpanUpTo(relEnd);
		const sourceAfterEnd = (totalSourceSpanTicks - sourceToEnd) as MediaTime;

		return {
			...element,
			id: generateUUID(),
			startTime: clipStart,
			duration: dur as MediaTime,
			trimStart: (element.trimStart + sourceToStart) as MediaTime,
			trimEnd: (element.trimEnd + sourceAfterEnd) as MediaTime,
		};
	};

	const pieces: TimelineElement[] = [];
	let cursor = eStart;

	for (const range of overlapping) {
		const overlapStart = Math.max(eStart, range.start) as MediaTime;
		const overlapEnd = Math.min(eEnd, range.end) as MediaTime;

		// Non-silent piece before this range
		if (cursor < overlapStart) {
			const piece = makeSubclip(cursor as MediaTime, overlapStart);
			if (piece) pieces.push(piece);
		}
		// Skip the silent overlap
		cursor = overlapEnd;
	}

	// Non-silent tail after last range
	if (cursor < eEnd) {
		const piece = makeSubclip(cursor as MediaTime, eEnd as MediaTime);
		if (piece) pieces.push(piece);
	}

	return pieces;
}

// Compute how much to shift an element's startTime leftward after all
// preceding silent ranges have been removed (ripple delete).
function rippleShiftFor(
	startTime: MediaTime,
	ranges: SilentTimeRange[],
): MediaTime {
	let shift = 0;
	for (const range of ranges) {
		if (range.end <= startTime) {
			shift += range.end - range.start;
		}
	}
	return shift as MediaTime;
}

export class RemoveSilenceCommand extends Command {
	private savedTracks: SceneTracks | null = null;

	constructor(private readonly silentRanges: SilentTimeRange[]) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedTracks = editor.scenes.getActiveScene().tracks;

		const applyToTrack = <TTrack extends { id: string; elements: TimelineElement[] }>(
			track: TTrack,
		): TTrack => {
			const newElements: TimelineElement[] = [];

			for (const element of track.elements) {
				const pieces = splitElementAroundRanges(element, this.silentRanges);
				for (const piece of pieces) {
					const shift = rippleShiftFor(piece.startTime, this.silentRanges);
					newElements.push({
						...piece,
						startTime: (piece.startTime - shift) as MediaTime,
					});
				}
			}

			return { ...track, elements: newElements } as TTrack;
		};

		const applyBand = <T extends TimelineTrack>(band: T[]): T[] =>
			band.map((t) => applyToTrack(t));

		const newTracks: SceneTracks = {
			video: applyBand(this.savedTracks.video),
			text: applyBand(this.savedTracks.text),
			graphic: applyBand(this.savedTracks.graphic),
			effect: applyBand(this.savedTracks.effect),
			audio: applyBand(this.savedTracks.audio),
		};

		editor.timeline.updateTracks(newTracks);

		return {
			selection: {
				selectedElements: [],
				selectedKeyframes: [],
				keyframeSelectionAnchor: null,
				selectedMaskPoints: null,
			},
		};
	}

	undo(): void {
		if (this.savedTracks) {
			EditorCore.getInstance().timeline.updateTracks(this.savedTracks);
		}
	}
}
