import type { CompoundElement, SceneTracks, TimelineTrack } from "@/timeline";
import { getMainVideoTrack } from "@/timeline/scene-tracks-view";
import type { MediaAsset } from "@/media/types";
import { getAssetSourceStartTime } from "@/media/asset-source";
import { selectVideoAssetSource } from "./video-source";
import { RootNode } from "./nodes/root-node";
import { VideoNode } from "./nodes/video-node";
import { ImageNode } from "./nodes/image-node";
import { TextNode } from "./nodes/text-node";
import { StickerNode } from "./nodes/sticker-node";
import { GraphicNode } from "./nodes/graphic-node";
import { ColorNode } from "./nodes/color-node";
import { BlurBackgroundNode } from "./nodes/blur-background-node";
import { EffectLayerNode } from "./nodes/effect-layer-node";
import { TransitionNode } from "./nodes/transition-node";
import { CompoundNode } from "./nodes/compound-node";
import type { AnyBaseNode } from "./nodes/base-node";
import type { TBackground, TCanvasSize } from "@/project/types";
import { DEFAULT_BACKGROUND_BLUR_INTENSITY } from "@/background/blur";
import {
	buildTransformFromParams,
	readBlendModeFromParams,
	readOpacityFromParams,
	readReframeFromParams,
} from "@/rendering";
import {
	getTrackTransitionByElements,
	getTransitionWindow,
	transitionRegistry,
} from "@/transitions";
import type { ImageElement, VideoElement, VideoTrack } from "@/timeline";

const PREVIEW_MAX_IMAGE_SIZE = 2048;

function getVisibleSortedElements({ track }: { track: TimelineTrack }) {
	return track.elements
		.filter((element) => !("hidden" in element && element.hidden))
		.slice()
		.sort((a, b) => {
			if (a.startTime !== b.startTime) return a.startTime - b.startTime;
			return a.id.localeCompare(b.id);
		});
}

function buildTrackNodes({
	tracks,
	mediaMap,
	canvasSize,
	isPreview,
	activeCompoundIds,
}: {
	tracks: TimelineTrack[];
	mediaMap: Map<string, MediaAsset>;
	canvasSize: TCanvasSize;
	isPreview?: boolean;
	activeCompoundIds: ReadonlySet<string>;
}): AnyBaseNode[] {
	const nodes: AnyBaseNode[] = [];

	for (const track of tracks) {
		if (track.type === "video") {
			nodes.push(
				...buildVideoTrackNodes({
					track,
					mediaMap,
					canvasSize,
					isPreview,
					activeCompoundIds,
				}),
			);
			continue;
		}

		const elements = getVisibleSortedElements({ track });

		for (const element of elements) {
			if (element.type === "effect") {
				nodes.push(
					new EffectLayerNode({
						effectType: element.effectType,
						effectParams: element.params,
						timeOffset: element.startTime,
						duration: element.duration,
					}),
				);
				continue;
			}

			if (element.type === "video" || element.type === "image") {
				const node = buildVideoLikeNode({
					element,
					mediaMap,
					isPreview,
				});
				if (node) {
					nodes.push(node);
				}
			}

			if (element.type === "text") {
				nodes.push(
					new TextNode({
						...element,
						transform: buildTransformFromParams({ params: element.params }),
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						canvasCenter: { x: canvasSize.width / 2, y: canvasSize.height / 2 },
						canvasHeight: canvasSize.height,
						textBaseline: "middle",
						effects: element.effects ?? [],
					}),
				);
			}

			if (element.type === "sticker") {
				nodes.push(
					new StickerNode({
						stickerId: element.stickerId,
						intrinsicWidth: element.intrinsicWidth,
						intrinsicHeight: element.intrinsicHeight,
						duration: element.duration,
						timeOffset: element.startTime,
						trimStart: element.trimStart,
						trimEnd: element.trimEnd,
						transform: buildTransformFromParams({ params: element.params }),
						reframe: readReframeFromParams({ params: element.params }),
						animations: element.animations,
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						effects: element.effects ?? [],
					}),
				);
			}

			if (element.type === "graphic") {
				nodes.push(
					new GraphicNode({
						definitionId: element.definitionId,
						params: element.params,
						duration: element.duration,
						timeOffset: element.startTime,
						trimStart: element.trimStart,
						trimEnd: element.trimEnd,
						transform: buildTransformFromParams({ params: element.params }),
						reframe: readReframeFromParams({ params: element.params }),
						animations: element.animations,
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						effects: element.effects ?? [],
						masks: element.masks ?? [],
					}),
				);
			}
		}
	}

	return nodes;
}

function buildVideoTrackNodes({
	track,
	mediaMap,
	canvasSize,
	isPreview,
	activeCompoundIds,
}: {
	track: VideoTrack;
	mediaMap: Map<string, MediaAsset>;
	canvasSize: TCanvasSize;
	isPreview?: boolean;
	activeCompoundIds: ReadonlySet<string>;
}): AnyBaseNode[] {
	const elements = getVisibleSortedElements({ track });
	const nodes: AnyBaseNode[] = [];

	for (let index = 0; index < elements.length; index++) {
		const element = elements[index];
		const previousElement = elements[index - 1];
		const nextElement = elements[index + 1];
		if (element.type === "compound") {
			const compoundNode = buildCompoundNode({
				element,
				mediaMap,
				canvasSize,
				isPreview,
				activeCompoundIds,
			});
			if (compoundNode) nodes.push(compoundNode);
			continue;
		}
		if (element.type !== "video" && element.type !== "image") {
			continue;
		}

		let visibleEndTime: number | undefined;
		let playbackStartTime: number | undefined;
		let transitionNode: TransitionNode | null = null;

		if (
			previousElement &&
			(previousElement.type === "video" || previousElement.type === "image")
		) {
			const previousTransition = getTrackTransitionByElements({
				track,
				fromElementId: previousElement.id,
				toElementId: element.id,
			});
			const previousDefinition =
				previousTransition != null
					? transitionRegistry.get(previousTransition.type)
					: null;

			if (previousTransition && previousDefinition) {
				playbackStartTime = getTransitionWindow({
					transition: previousTransition,
					cutTime: element.startTime,
				}).startTime;
			}
		}

		if (
			nextElement &&
			(nextElement.type === "video" || nextElement.type === "image")
		) {
			const transition = getTrackTransitionByElements({
				track,
				fromElementId: element.id,
				toElementId: nextElement.id,
			});
			const definition =
				transition != null ? transitionRegistry.get(transition.type) : null;

			if (transition && definition) {
				const { startTime } = getTransitionWindow({
					transition,
					cutTime: nextElement.startTime,
				});
				visibleEndTime = startTime;

				const outgoingNode = buildVideoLikeNode({
					element,
					mediaMap,
					isPreview,
				});
				const incomingNode = buildVideoLikeNode({
					element: nextElement,
					mediaMap,
					isPreview,
					timeOffsetOverride: startTime,
					durationOverride: transition.duration,
					playbackStartTimeOverride: startTime,
				});

				if (
					outgoingNode &&
					incomingNode &&
					(outgoingNode instanceof VideoNode ||
						outgoingNode instanceof ImageNode) &&
					(incomingNode instanceof VideoNode ||
						incomingNode instanceof ImageNode)
				) {
					transitionNode = new TransitionNode({
						timeOffset: startTime,
						duration: transition.duration,
						definition,
						params: transition.params ?? {},
						outgoingNode,
						incomingNode,
					});
				}
			}
		}

		const regularNode = buildVideoLikeNode({
			element,
			mediaMap,
			isPreview,
			visibleEndTime,
			playbackStartTimeOverride: playbackStartTime,
		});
		if (regularNode) {
			nodes.push(regularNode);
		}
		if (transitionNode) {
			nodes.push(transitionNode);
		}
	}

	return nodes;
}

function buildCompoundNode({
	element,
	mediaMap,
	canvasSize,
	isPreview,
	activeCompoundIds,
}: {
	element: CompoundElement;
	mediaMap: Map<string, MediaAsset>;
	canvasSize: TCanvasSize;
	isPreview?: boolean;
	activeCompoundIds: ReadonlySet<string>;
}): CompoundNode | null {
	// Imported or hand-edited projects can contain a self-reference. Guard the
	// active ancestry, while allowing independent occurrences of a clip id.
	if (activeCompoundIds.has(element.id)) return null;
	const ancestry = new Set(activeCompoundIds);
	ancestry.add(element.id);
	const node = new CompoundNode({
		compoundId: element.id,
		duration: element.duration,
		timeOffset: element.startTime,
		trimStart: element.trimStart,
		trimEnd: element.trimEnd,
		transform: buildTransformFromParams({ params: element.params }),
		animations: element.animations,
		opacity: readOpacityFromParams({ params: element.params }),
		blendMode: readBlendModeFromParams({ params: element.params }),
		effects: element.effects ?? [],
	});
	const tracks = element.tracks;
	const visibleTracks = [
		...tracks.video.filter((track) => !track.hidden),
		...tracks.text.filter((track) => !track.hidden),
		...tracks.graphic.filter((track) => !track.hidden),
		...tracks.effect.filter((track) => !track.hidden),
	];
	for (const child of buildTrackNodes({
		tracks: visibleTracks,
		mediaMap,
		canvasSize,
		isPreview,
		activeCompoundIds: ancestry,
	})) node.add(child);
	return node;
}

function buildVideoLikeNode({
	element,
	mediaMap,
	isPreview,
	visibleEndTime,
	timeOffsetOverride,
	durationOverride,
	playbackStartTimeOverride,
}: {
	element: VideoElement | ImageElement;
	mediaMap: Map<string, MediaAsset>;
	isPreview?: boolean;
	visibleEndTime?: number;
	timeOffsetOverride?: number;
	durationOverride?: number;
	playbackStartTimeOverride?: number;
}): VideoNode | ImageNode | null {
	const mediaAsset = mediaMap.get(element.mediaId);
	if (!mediaAsset?.file || !mediaAsset?.url) {
		return null;
	}

	const commonParams = {
		duration: durationOverride ?? element.duration,
		timeOffset: timeOffsetOverride ?? element.startTime,
		playbackStartTime: playbackStartTimeOverride,
		visibleStartTime: timeOffsetOverride,
		visibleEndTime,
		trimStart:
			getAssetSourceStartTime({ asset: mediaAsset }) + element.trimStart,
		trimEnd: element.trimEnd,
		transform: buildTransformFromParams({ params: element.params }),
		reframe: readReframeFromParams({ params: element.params }),
		animations: element.animations,
		opacity: readOpacityFromParams({ params: element.params }),
		blendMode: readBlendModeFromParams({ params: element.params }),
		effects: element.effects ?? [],
		masks: element.masks ?? [],
	};

	if (element.type === "video" && mediaAsset.type === "video") {
		// Preview decodes the editing proxy when there is one: masters are
		// routinely long-GOP, high-bitrate captures that no browser can scrub,
		// whereas the proxy is all-intra so any frame decodes standalone. Export
		// deliberately falls through to the master, keeping renders full quality.
		// The proxy gets its own cache id so the two never share a decoder sink.
		const source = selectVideoAssetSource({
			asset: mediaAsset,
			isPreview: isPreview === true,
		});
		return new VideoNode({
			mediaId: source.mediaId,
			url: mediaAsset.url,
			file: source.file,
			retime: element.retime,
			...commonParams,
		});
	}

	if (element.type === "image" && mediaAsset.type === "image") {
		return new ImageNode({
			url: mediaAsset.url,
			...(isPreview && {
				maxSourceSize: PREVIEW_MAX_IMAGE_SIZE,
			}),
			...commonParams,
		});
	}

	return null;
}

function buildBlurBackgroundNodes({
	track,
	mediaMap,
	blurIntensity,
}: {
	track: TimelineTrack | undefined;
	mediaMap: Map<string, MediaAsset>;
	blurIntensity: number;
}): AnyBaseNode[] {
	if (!track) {
		return [];
	}

	const nodes: AnyBaseNode[] = [];
	const elements = getVisibleSortedElements({ track });

	for (const element of elements) {
		if (element.type !== "video" && element.type !== "image") {
			continue;
		}

		const mediaAsset = mediaMap.get(element.mediaId);
		if (
			!mediaAsset?.file ||
			!mediaAsset?.url ||
			(mediaAsset.type !== "video" && mediaAsset.type !== "image")
		) {
			continue;
		}

		nodes.push(
			new BlurBackgroundNode({
				mediaId: mediaAsset.id,
				url: mediaAsset.url,
				file: mediaAsset.file,
				mediaType: mediaAsset.type,
				duration: element.duration,
				timeOffset: element.startTime,
				trimStart:
					getAssetSourceStartTime({ asset: mediaAsset }) + element.trimStart,
				trimEnd: element.trimEnd,
				retime: element.type === "video" ? element.retime : undefined,
				blurIntensity,
			}),
		);
	}

	return nodes;
}

export type BuildSceneParams = {
	canvasSize: TCanvasSize;
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	duration: number;
	background: TBackground;
	isPreview?: boolean;
};

export function buildScene({
	canvasSize,
	tracks,
	mediaAssets,
	duration,
	background,
	isPreview,
}: BuildSceneParams) {
	const rootNode = new RootNode({ duration });
	const mediaMap = new Map(mediaAssets.map((m) => [m.id, m]));

	const mainVideoTrack = getMainVideoTrack({ tracks });
	// Post-R1: compose every visible band into one bottom-to-top render list.
	// The pre-R1 code put overlay tracks above main; the new order preserves
	// that intent (video[0] is bottom-most, higher video indices layer on top,
	// then text/graphic/effect stack above the video band).
	const visibleTracks = [
		...tracks.video.filter((track) => !track.hidden),
		...tracks.text.filter((track) => !track.hidden),
		...tracks.graphic.filter((track) => !track.hidden),
		...tracks.effect.filter((track) => !track.hidden),
	];
	const orderedTracksBottomToTop = visibleTracks;
	const mainTrack = mainVideoTrack.hidden ? undefined : mainVideoTrack;

	const allNodes = buildTrackNodes({
		tracks: orderedTracksBottomToTop,
		mediaMap,
		canvasSize,
		isPreview,
		activeCompoundIds: new Set(),
	});

	if (background.type === "blur") {
		const blurNodes = buildBlurBackgroundNodes({
			track: mainTrack,
			mediaMap,
			blurIntensity:
				background.blurIntensity ?? DEFAULT_BACKGROUND_BLUR_INTENSITY,
		});
		for (const node of blurNodes) {
			rootNode.add(node);
		}
	} else if (
		background.type === "color" &&
		background.color !== "transparent"
	) {
		rootNode.add(new ColorNode({ color: background.color }));
	}

	for (const node of allNodes) {
		rootNode.add(node);
	}

	return rootNode;
}
