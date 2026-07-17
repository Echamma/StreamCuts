import { PlaybackManager } from "./managers/playback-manager";
import { TimelineManager } from "./managers/timeline-manager";
import { ScenesManager } from "./managers/scenes-manager";
import { ProjectManager } from "./managers/project-manager";
import { MediaManager } from "./managers/media-manager";
import { RendererManager } from "./managers/renderer-manager";
import { CommandManager } from "./managers/commands";
import { SaveManager } from "./managers/save-manager";
import { SnapshotManager } from "./managers/snapshot-manager";
import { AudioManager } from "./managers/audio-manager";
import { SelectionManager } from "./managers/selection-manager";
import { ClipboardManager } from "./managers/clipboard-manager";
import { DiagnosticsManager } from "./managers/diagnostics-manager";
import { AssetPreparationService } from "@/services/asset-preparation/service";
import { registerDefaultEffects } from "@/effects";
import { registerDefaultMasks } from "@/masks";
import { registerDefaultTransitions } from "@/transitions";
import { registerTranscriptionDiagnostics } from "@/transcription/diagnostics";
import type { SceneTracks } from "@/timeline/types";

export class EditorCore {
	private static instance: EditorCore | null = null;
	public readonly timeline: TimelineManager;
	public readonly command: CommandManager;
	public readonly playback: PlaybackManager;
	public readonly scenes: ScenesManager;
	public readonly project: ProjectManager;
	public readonly media: MediaManager;
	public readonly renderer: RendererManager;
	public readonly save: SaveManager;
	public readonly snapshots: SnapshotManager;
	public readonly audio: AudioManager;
	public readonly selection: SelectionManager;
	public readonly clipboard: ClipboardManager;
	public readonly diagnostics: DiagnosticsManager;
	public readonly assetPrep: AssetPreparationService;

	private constructor() {
		registerDefaultEffects();
		registerDefaultMasks();
		registerDefaultTransitions();
		this.command = new CommandManager(this);
		this.timeline = new TimelineManager(this);
		this.playback = new PlaybackManager(this);
		this.scenes = new ScenesManager(this);
		this.project = new ProjectManager(this);
		this.media = new MediaManager(this);
		this.renderer = new RendererManager(this);
		this.save = new SaveManager({ editor: this });
		this.snapshots = new SnapshotManager({ editor: this });
		this.audio = new AudioManager(this);
		this.selection = new SelectionManager(this);
		this.clipboard = new ClipboardManager(this);
		this.diagnostics = new DiagnosticsManager(this);
		this.assetPrep = new AssetPreparationService(this);
		registerTranscriptionDiagnostics({ diagnostics: this.diagnostics });
		this.playback.bindTimelineScope();
		this.command.registerReactor(() => {
			const activeScene = this.scenes.getActiveSceneOrNull();
			if (!activeScene) {
				return;
			}

			const tracks = activeScene.tracks;
			// Ripple track (video[0]) is never pruned even when empty — it's the
			// scene's anchor. Every other track drops when it has no elements.
			const prunedTracks: SceneTracks = {
				video: tracks.video.filter(
					(track, index) => index === 0 || track.elements.length > 0,
				),
				text: tracks.text.filter((track) => track.elements.length > 0),
				graphic: tracks.graphic.filter((track) => track.elements.length > 0),
				effect: tracks.effect.filter((track) => track.elements.length > 0),
				audio: tracks.audio.filter((track) => track.elements.length > 0),
			};
			if (
				prunedTracks.video.length !== tracks.video.length ||
				prunedTracks.text.length !== tracks.text.length ||
				prunedTracks.graphic.length !== tracks.graphic.length ||
				prunedTracks.effect.length !== tracks.effect.length ||
				prunedTracks.audio.length !== tracks.audio.length
			) {
				this.timeline.updateTracks(prunedTracks);
			}
		});
		this.save.start();
		this.snapshots.start();
	}

	static getInstance(): EditorCore {
		if (!EditorCore.instance) {
			EditorCore.instance = new EditorCore();
		}
		return EditorCore.instance;
	}

	static reset(): void {
		EditorCore.instance = null;
	}
}
