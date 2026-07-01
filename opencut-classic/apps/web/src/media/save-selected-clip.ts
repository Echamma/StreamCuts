import type { EditorCore } from "@/core";
import {
	estimateSubclipAssetSize,
	findRootSourceAsset,
	getMediaAssetSource,
} from "@/media/asset-source";
import { getSourceSpanAtClipTime } from "@/retime";
import {
	hasMediaId,
	isRetimableElement,
	type AudioElement,
	type VideoElement,
} from "@/timeline";
import { doesElementHaveEnabledAudio } from "@/timeline/audio-separation";
import type { MediaAsset } from "@/media/types";
import { mediaTimeFromSeconds, TICKS_PER_SECOND } from "@/wasm";

type SaveableTimelineElement = AudioElement | VideoElement;

const sanitizeFileStem = (value: string) =>
	value
		.replace(/\.[a-z0-9]+$/i, "")
		.replace(/[<>:"/\\|?*]+/g, "-")
		.split("")
		.map((char) => (char.charCodeAt(0) < 32 ? "-" : char))
		.join("")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase() || "clip";

const formatFileTimestamp = (seconds: number) => {
	const total = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const remainingSeconds = total % 60;

	return [hours, minutes, remainingSeconds]
		.map((value) => String(value).padStart(2, "0"))
		.join("-");
};

function inferAssetExtension({
	element,
	name,
}: {
	element: SaveableTimelineElement;
	name: string;
}): string {
	const match = name.match(/\.([a-z0-9]+)$/i);
	if (match?.[1]) {
		return match[1].toLowerCase();
	}

	return element.type === "audio" ? "m4a" : "mp4";
}

function buildClipAssetName({
	baseName,
	startSeconds,
	durationSeconds,
	extension,
}: {
	baseName: string;
	startSeconds: number;
	durationSeconds: number;
	extension: string;
}) {
	return `${sanitizeFileStem(baseName)}-${formatFileTimestamp(
		startSeconds,
	)}-${formatFileTimestamp(startSeconds + durationSeconds)}.${extension}`;
}

export async function saveTimelineClipToAssets({
	editor,
	projectId,
	element,
	mediaAsset,
}: {
	editor: EditorCore;
	projectId: string;
	element: SaveableTimelineElement;
	mediaAsset: MediaAsset;
}): Promise<MediaAsset> {
	if (!hasMediaId(element)) {
		throw new Error("Only media-backed clips can be saved to Assets.");
	}

	const rootSourceAsset =
		findRootSourceAsset({
			asset: mediaAsset,
			assets: editor.media.getAssets(),
		}) ?? mediaAsset;
	if (!rootSourceAsset.file) {
		throw new Error("The source media is unavailable.");
	}

	const assetSource = getMediaAssetSource({ asset: mediaAsset });
	const assetSourceStartTime =
		assetSource.kind === "subclip" ? assetSource.sourceStartTime : 0;
	const startSeconds =
		(assetSourceStartTime + element.trimStart) / TICKS_PER_SECOND;
	const durationSeconds = getSourceSpanAtClipTime({
		clipTime: element.duration / TICKS_PER_SECOND,
		retime: isRetimableElement(element) ? element.retime : undefined,
	});

	if (durationSeconds <= 0) {
		throw new Error("The selected clip has no visible duration.");
	}

	const sourceDuration = mediaTimeFromSeconds({ seconds: durationSeconds });
	const includeAudio =
		element.type === "audio" ||
		doesElementHaveEnabledAudio({
			element,
			mediaAsset,
		});
	const extension = inferAssetExtension({
		element,
		name: rootSourceAsset.name,
	});

	const importedAsset = await editor.media.addMediaAsset({
		projectId,
		asset: {
			name: buildClipAssetName({
				baseName: element.name || mediaAsset.name,
				startSeconds,
				durationSeconds,
				extension,
			}),
			type: element.type,
			size: estimateSubclipAssetSize({
				rootAsset: rootSourceAsset,
				sourceDuration,
			}),
			lastModified: rootSourceAsset.lastModified,
			file: rootSourceAsset.file,
			url: rootSourceAsset.url,
			width: element.type === "video" ? rootSourceAsset.width : undefined,
			height: element.type === "video" ? rootSourceAsset.height : undefined,
			duration: element.duration / TICKS_PER_SECOND,
			fps: element.type === "video" ? rootSourceAsset.fps : undefined,
			hasAudio: element.type === "audio" ? true : includeAudio,
			thumbnailUrl:
				element.type === "video" ? rootSourceAsset.thumbnailUrl : undefined,
			folderId: mediaAsset.folderId,
			sceneId: mediaAsset.sceneId,
			socialCopy: mediaAsset.socialCopy,
			source: {
				kind: "subclip",
				rootSourceAssetId: rootSourceAsset.id,
				sourceStartTime: assetSourceStartTime + element.trimStart,
				sourceDuration,
				timelineDuration: element.duration,
				retime: isRetimableElement(element) ? element.retime : undefined,
				includeAudio,
				savedFromAssetId: mediaAsset.id,
			},
		},
	});

	if (!importedAsset) {
		throw new Error("The selected clip could not be saved to Assets.");
	}

	return importedAsset;
}
