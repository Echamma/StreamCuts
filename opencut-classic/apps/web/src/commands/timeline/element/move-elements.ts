import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import {
	buildEmptyTrack,
	validateElementTrackCompatibility,
} from "@/timeline/placement";
import type {
	PlannedElementMove,
	PlannedTrackCreation,
} from "@/timeline/group-move";
import { findTrackInSceneTracks } from "@/timeline/track-element-update";
import {
	getAudioBaseIndex,
	getMainTrackRowIndex,
} from "@/timeline/scene-tracks-view";

export class MoveElementCommand extends Command {
	private savedState: SceneTracks | null = null;

	constructor({
		moves,
		createTracks = [],
	}: {
		moves: PlannedElementMove[];
		createTracks?: PlannedTrackCreation[];
	}) {
		super();
		this.moves = moves;
		this.createTracks = createTracks;
	}

	private readonly moves: PlannedElementMove[];
	private readonly createTracks: PlannedTrackCreation[];

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		let tracksToUpdate = this.savedState;
		for (const createTrack of [...this.createTracks].sort(
			(firstTrack, secondTrack) => firstTrack.index - secondTrack.index,
		)) {
			tracksToUpdate = insertTrackAtDisplayIndex({
				tracks: tracksToUpdate,
				track: buildEmptyTrack({
					id: createTrack.id,
					type: createTrack.type,
				}),
				insertIndex: createTrack.index,
			});
		}

		const movedElementsById = new Map<string, TimelineElement>();
		for (const move of this.moves) {
			const sourceTrack = findTrackInSceneTracks({
				tracks: this.savedState,
				trackId: move.sourceTrackId,
			});
			const sourceElement = sourceTrack?.elements.find(
				(trackElement) => trackElement.id === move.elementId,
			);
			if (!sourceTrack || !sourceElement) {
				throw new Error("Source track or element not found");
			}

			const targetTrack = findTrackInSceneTracks({
				tracks: tracksToUpdate,
				trackId: move.targetTrackId,
			});
			if (!targetTrack) {
				throw new Error("Target track not found");
			}

			const validation = validateElementTrackCompatibility({
				element: sourceElement,
				track: targetTrack,
			});
			if (!validation.isValid) {
				throw new Error(validation.errorMessage);
			}

			movedElementsById.set(move.elementId, {
				...sourceElement,
				startTime: move.newStartTime,
			});
		}

		const movedElementIds = new Set(this.moves.map((move) => move.elementId));
		const movedElementsByTargetTrackId = new Map<string, TimelineElement[]>();
		for (const move of this.moves) {
			const movedElement = movedElementsById.get(move.elementId);
			if (!movedElement) {
				continue;
			}

			const nextTargetElements =
				movedElementsByTargetTrackId.get(move.targetTrackId) ?? [];
			nextTargetElements.push(movedElement);
			movedElementsByTargetTrackId.set(move.targetTrackId, nextTargetElements);
		}

		const updatedTracks = mapSceneTracks({
			tracks: tracksToUpdate,
			update: (track) => ({
				...track,
				elements: [
					...track.elements.filter(
						(element) => !movedElementIds.has(element.id),
					),
					...(movedElementsByTargetTrackId.get(track.id) ?? []),
				],
			}),
		});

		editor.timeline.updateTracks(updatedTracks);
		return createElementSelectionResult(
			this.moves.map(({ elementId, targetTrackId }) => ({
				trackId: targetTrackId,
				elementId,
			})),
		);
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}

function mapSceneTracks({
	tracks,
	update,
}: {
	tracks: SceneTracks;
	update: <TTrack extends TimelineTrack>(track: TTrack) => TTrack;
}): SceneTracks {
	return {
		video: tracks.video.map((track) => update(track)),
		text: tracks.text.map((track) => update(track)),
		graphic: tracks.graphic.map((track) => update(track)),
		effect: tracks.effect.map((track) => update(track)),
		audio: tracks.audio.map((track) => update(track)),
	};
}

function insertTrackAtDisplayIndex({
	tracks,
	track,
	insertIndex,
}: {
	tracks: SceneTracks;
	track: TimelineTrack;
	insertIndex: number;
}): SceneTracks {
	// Post-R1 each track kind lives in its own band. The requested display
	// index is translated to a band-local position; effect/text/graphic sit
	// above the video band with a zero base (insertIndex clamped to band
	// length), audio sits after everything.
	if (track.type === "audio") {
		const bandIndex = Math.max(
			0,
			Math.min(insertIndex - getAudioBaseIndex({ tracks }), tracks.audio.length),
		);
		return {
			...tracks,
			audio: [
				...tracks.audio.slice(0, bandIndex),
				track,
				...tracks.audio.slice(bandIndex),
			],
		};
	}

	if (track.type === "video") {
		const bandIndex = Math.max(
			0,
			Math.min(insertIndex - getMainTrackRowIndex({ tracks }), tracks.video.length),
		);
		return {
			...tracks,
			video: [
				...tracks.video.slice(0, bandIndex),
				track,
				...tracks.video.slice(bandIndex),
			],
		};
	}

	if (track.type === "text") {
		const bandIndex = Math.max(0, Math.min(insertIndex, tracks.text.length));
		return {
			...tracks,
			text: [
				...tracks.text.slice(0, bandIndex),
				track,
				...tracks.text.slice(bandIndex),
			],
		};
	}

	if (track.type === "graphic") {
		const bandIndex = Math.max(0, Math.min(insertIndex, tracks.graphic.length));
		return {
			...tracks,
			graphic: [
				...tracks.graphic.slice(0, bandIndex),
				track,
				...tracks.graphic.slice(bandIndex),
			],
		};
	}

	// effect
	const bandIndex = Math.max(0, Math.min(insertIndex, tracks.effect.length));
	return {
		...tracks,
		effect: [
			...tracks.effect.slice(0, bandIndex),
			track,
			...tracks.effect.slice(bandIndex),
		],
	};
}
