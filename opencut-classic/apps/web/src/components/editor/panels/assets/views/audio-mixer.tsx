"use client";

import { useEditor, useScenes } from "@/editor/use-editor";
import {
	getElementVolume,
	isElementMuted,
} from "@/timeline/audio-state";
import { VOLUME_DB_MIN, VOLUME_DB_MAX } from "@/timeline/audio-constants";
import { PanelView } from "./base-panel";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import { VolumeHighIcon, VolumeOffIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/utils/ui";
import type {
	AudioElement,
	AudioTrack,
	VideoElement,
	VideoTrack,
} from "@/timeline";

function dbToSlider(db: number): number {
	return ((db - VOLUME_DB_MIN) / (VOLUME_DB_MAX - VOLUME_DB_MIN)) * 100;
}

function sliderToDb(val: number): number {
	return VOLUME_DB_MIN + (val / 100) * (VOLUME_DB_MAX - VOLUME_DB_MIN);
}

function formatDb(db: number): string {
	if (db <= VOLUME_DB_MIN) return "-∞";
	return `${db >= 0 ? "+" : ""}${db.toFixed(1)} dB`;
}

export function AudioMixerView() {
	const editor = useEditor();
	const tracks = useScenes(
		(e) => e.scenes.getActiveSceneOrNull()?.tracks ?? null,
	);

	if (!tracks) {
		return (
			<PanelView title="Audio">
				<div className="text-muted-foreground p-4 text-sm">
					No project loaded.
				</div>
			</PanelView>
		);
	}

	const mainVideoElements = tracks.main.elements.filter(
		(el): el is VideoElement => el.type === "video",
	);

	const overlayVideoTracks = tracks.overlay.filter(
		(t): t is VideoTrack => t.type === "video",
	);

	const audioTracks = tracks.audio.filter((t) => t.elements.length > 0);

	const hasAny =
		mainVideoElements.length > 0 ||
		overlayVideoTracks.some((t) =>
			t.elements.some((el) => el.type === "video"),
		) ||
		audioTracks.length > 0;

	if (!hasAny) {
		return (
			<PanelView title="Audio">
				<div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
					<HugeiconsIcon
						icon={VolumeHighIcon}
						className="text-muted-foreground size-10"
					/>
					<div className="flex flex-col gap-1">
						<p className="font-medium">No audio in your project</p>
						<p className="text-muted-foreground text-sm text-balance">
							Add a video or audio clip to the timeline to see controls here.
						</p>
					</div>
				</div>
			</PanelView>
		);
	}

	return (
		<PanelView title="Audio">
			<div className="flex flex-col gap-1 pb-4">
				{(mainVideoElements.length > 0 ||
					overlayVideoTracks.some((t) =>
						t.elements.some((el) => el.type === "video"),
					)) && (
					<>
						<TrackSection
							label="Video"
							trackId={tracks.main.id}
							trackMuted={tracks.main.muted}
							onToggleTrackMute={() =>
								editor.timeline.toggleTrackMute({ trackId: tracks.main.id })
							}
						>
							{mainVideoElements.map((el) => (
								<ElementMixerRow
									key={el.id}
									element={el}
									trackId={tracks.main.id}
									trackMuted={tracks.main.muted}
								/>
							))}
						</TrackSection>

						{overlayVideoTracks.map((overlayTrack) => {
							const videoEls = overlayTrack.elements.filter(
								(el): el is VideoElement => el.type === "video",
							);
							if (videoEls.length === 0) return null;
							return (
								<TrackSection
									key={overlayTrack.id}
									label={overlayTrack.name}
									trackId={overlayTrack.id}
									trackMuted={overlayTrack.muted}
									onToggleTrackMute={() =>
										editor.timeline.toggleTrackMute({
											trackId: overlayTrack.id,
										})
									}
								>
									{videoEls.map((el) => (
										<ElementMixerRow
											key={el.id}
											element={el}
											trackId={overlayTrack.id}
											trackMuted={overlayTrack.muted}
										/>
									))}
								</TrackSection>
							);
						})}

						{audioTracks.length > 0 && <Separator className="my-1" />}
					</>
				)}

				{audioTracks.map((audioTrack) => (
					<TrackSection
						key={audioTrack.id}
						label={audioTrack.name}
						trackId={audioTrack.id}
						trackMuted={audioTrack.muted}
						onToggleTrackMute={() =>
							editor.timeline.toggleTrackMute({ trackId: audioTrack.id })
						}
					>
						{audioTrack.elements.map((el) => (
							<ElementMixerRow
								key={el.id}
								element={el}
								trackId={audioTrack.id}
								trackMuted={audioTrack.muted}
							/>
						))}
					</TrackSection>
				))}
			</div>
		</PanelView>
	);
}

function TrackSection({
	label,
	trackMuted,
	onToggleTrackMute,
	children,
}: {
	label: string;
	trackId: string;
	trackMuted: boolean;
	onToggleTrackMute: () => void;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center justify-between px-1 pt-3 pb-1">
				<span className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
					{label}
				</span>
				<Button
					variant={trackMuted ? "secondary" : "ghost"}
					size="icon"
					className="size-6"
					onClick={onToggleTrackMute}
					title={trackMuted ? "Unmute track" : "Mute track"}
				>
					<HugeiconsIcon
						icon={trackMuted ? VolumeOffIcon : VolumeHighIcon}
						className="size-3.5"
					/>
				</Button>
			</div>
			<div className="flex flex-col gap-1.5">{children}</div>
		</div>
	);
}

function ElementMixerRow({
	element,
	trackId,
	trackMuted,
}: {
	element: VideoElement | AudioElement;
	trackId: string;
	trackMuted: boolean;
}) {
	const editor = useEditor();
	const volumeDb = getElementVolume({ element });
	const muted = isElementMuted({ element });
	const effectiveMuted = trackMuted || muted;

	const handleVolumeChange = (values: number[]) => {
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch: {
						params: { ...element.params, volume: sliderToDb(values[0]) },
					},
				},
			],
			pushHistory: false,
		});
	};

	const handleVolumeCommit = (values: number[]) => {
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch: {
						params: { ...element.params, volume: sliderToDb(values[0]) },
					},
				},
			],
		});
	};

	const handleMuteToggle = () => {
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch: {
						params: { ...element.params, muted: !muted },
					},
				},
			],
		});
	};

	return (
		<div
			className={cn(
				"bg-accent/40 flex flex-col gap-2.5 rounded-lg p-3",
				effectiveMuted && "opacity-50",
			)}
		>
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 truncate text-sm font-medium">
					{element.name}
				</span>
				<span
					className={cn(
						"shrink-0 font-mono text-xs tabular-nums",
						effectiveMuted ? "text-muted-foreground" : "text-foreground",
					)}
				>
					{formatDb(volumeDb)}
				</span>
				<Button
					variant={muted ? "secondary" : "ghost"}
					size="icon"
					className="size-6 shrink-0"
					onClick={handleMuteToggle}
					title={muted ? "Unmute clip" : "Mute clip"}
				>
					<HugeiconsIcon
						icon={muted ? VolumeOffIcon : VolumeHighIcon}
						className="size-3.5"
					/>
				</Button>
			</div>
			<Slider
				value={[dbToSlider(volumeDb)]}
				onValueChange={handleVolumeChange}
				onValueCommit={handleVolumeCommit}
				min={0}
				max={100}
				step={0.5}
				disabled={effectiveMuted}
			/>
		</div>
	);
}
