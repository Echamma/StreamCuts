import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks } from "@/timeline";

export class RemoveTrackCommand extends Command {
	private savedState: SceneTracks | null = null;

	constructor(private trackId: string) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		const target = this.trackId;
		// The ripple video track (video[0]) is never removed; every other track
		// filters out by id-match across every band.
		const updatedTracks: SceneTracks = {
			video: this.savedState.video.filter(
				(track, index) => index === 0 || track.id !== target,
			),
			text: this.savedState.text.filter((track) => track.id !== target),
			graphic: this.savedState.graphic.filter((track) => track.id !== target),
			effect: this.savedState.effect.filter((track) => track.id !== target),
			audio: this.savedState.audio.filter((track) => track.id !== target),
		};
		editor.timeline.updateTracks(updatedTracks);
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}
