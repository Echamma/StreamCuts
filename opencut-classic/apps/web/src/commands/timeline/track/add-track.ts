import { Command, type CommandResult } from "@/commands/base-command";
import type { SceneTracks, TrackType } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { EditorCore } from "@/core";
import {
	buildEmptyTrack,
	getDefaultInsertIndexForTrack,
} from "@/timeline/placement";
import {
	getAudioBaseIndex,
	getMainTrackRowIndex,
} from "@/timeline/scene-tracks-view";

export class AddTrackCommand extends Command {
	private trackId: string;
	private savedState: SceneTracks | null = null;

	constructor({
		type,
		index,
	}: {
		type: TrackType;
		index?: number;
	}) {
		super();
		this.type = type;
		this.index = index;
		this.trackId = generateUUID();
	}

	private type: TrackType;
	private index?: number;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const insertIndex =
			this.index ??
			getDefaultInsertIndexForTrack({
				tracks: this.savedState,
				trackType: this.type,
			});

		const updatedTracks = buildTrackInsertion({
			tracks: this.savedState,
			insertIndex,
			trackId: this.trackId,
			trackType: this.type,
		});

		editor.timeline.updateTracks(updatedTracks);
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}

	getTrackId(): string {
		return this.trackId;
	}
}

function buildTrackInsertion({
	tracks,
	insertIndex,
	trackId,
	trackType,
}: {
	tracks: SceneTracks;
	insertIndex: number;
	trackId: string;
	trackType: TrackType;
}): SceneTracks {
	if (trackType === "audio") {
		const bandIndex = Math.max(
			0,
			insertIndex - getAudioBaseIndex({ tracks }),
		);
		const newTrack = buildEmptyTrack({ id: trackId, type: "audio" });
		return {
			...tracks,
			audio: [
				...tracks.audio.slice(0, bandIndex),
				newTrack,
				...tracks.audio.slice(bandIndex),
			],
		};
	}

	if (trackType === "video") {
		const bandIndex = Math.max(
			0,
			Math.min(insertIndex - getMainTrackRowIndex({ tracks }), tracks.video.length),
		);
		const newTrack = buildEmptyTrack({ id: trackId, type: "video" });
		return {
			...tracks,
			video: [
				...tracks.video.slice(0, bandIndex),
				newTrack,
				...tracks.video.slice(bandIndex),
			],
		};
	}

	if (trackType === "text") {
		const bandIndex = Math.max(0, Math.min(insertIndex, tracks.text.length));
		const newTrack = buildEmptyTrack({ id: trackId, type: "text" });
		return {
			...tracks,
			text: [
				...tracks.text.slice(0, bandIndex),
				newTrack,
				...tracks.text.slice(bandIndex),
			],
		};
	}

	if (trackType === "graphic") {
		const bandIndex = Math.max(0, Math.min(insertIndex, tracks.graphic.length));
		const newTrack = buildEmptyTrack({ id: trackId, type: "graphic" });
		return {
			...tracks,
			graphic: [
				...tracks.graphic.slice(0, bandIndex),
				newTrack,
				...tracks.graphic.slice(bandIndex),
			],
		};
	}

	// effect
	const bandIndex = Math.max(0, Math.min(insertIndex, tracks.effect.length));
	const newTrack = buildEmptyTrack({ id: trackId, type: "effect" });
	return {
		...tracks,
		effect: [
			...tracks.effect.slice(0, bandIndex),
			newTrack,
			...tracks.effect.slice(bandIndex),
		],
	};
}
