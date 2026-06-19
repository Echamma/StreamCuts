export type PreviewQualityTier = "full" | "interactive" | "proxy";

export type PlaybackIntent = "idle" | "playback" | "scrub";

export function resolvePlaybackIntent({
	isPlaying,
	isScrubbing,
}: {
	isPlaying: boolean;
	isScrubbing: boolean;
}): PlaybackIntent {
	if (isScrubbing) {
		return "scrub";
	}

	if (isPlaying) {
		return "playback";
	}

	return "idle";
}

export function resolvePreviewQualityTier({
	isPlaying,
	isScrubbing,
	isDegraded,
}: {
	isPlaying: boolean;
	isScrubbing: boolean;
	isDegraded: boolean;
}): PreviewQualityTier {
	if (isDegraded && (isPlaying || isScrubbing)) {
		return "proxy";
	}

	if (isPlaying || isScrubbing) {
		return "interactive";
	}

	return "full";
}
