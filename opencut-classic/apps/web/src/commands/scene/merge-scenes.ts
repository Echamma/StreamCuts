import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { TScene } from "@/timeline";
import { buildDefaultScene, mergeSceneTracks } from "@/timeline/scenes";

export class MergeScenesCommand extends Command {
	private savedScenes: TScene[] | null = null;
	private mergedScene: TScene | null = null;

	constructor(
		private params: { sceneIds: string[]; outputName: string },
	) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedScenes = [...editor.scenes.getScenes()];

		const scenes = this.params.sceneIds
			.map((id) => this.savedScenes!.find((s) => s.id === id))
			.filter((s): s is TScene => s != null);

		if (scenes.length < 2) return undefined;

		const { tracks, bookmarks } = mergeSceneTracks({ scenes });

		this.mergedScene = {
			...buildDefaultScene({ name: this.params.outputName, isMain: false }),
			tracks,
			bookmarks,
		};

		editor.scenes.setScenes({
			scenes: [...this.savedScenes, this.mergedScene],
		});

		return undefined;
	}

	undo(): void {
		if (this.savedScenes) {
			EditorCore.getInstance().scenes.setScenes({ scenes: this.savedScenes });
		}
	}

	getMergedSceneId(): string {
		return this.mergedScene?.id ?? "";
	}
}
