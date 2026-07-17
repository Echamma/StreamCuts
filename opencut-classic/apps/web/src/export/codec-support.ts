/**
 * Runtime capability probes for optional codec paths (DEL-002 AV1). Kept out of
 * `index.ts` so we can call it lazily from the export popover and skip the
 * WebCodecs plumbing entirely in SSR + node test environments.
 */

/** Reasonable AV1 baseline for delivery: Main profile, Level 5.0, 8-bit. */
export const AV1_CODEC_STRING = "av01.0.05M.08" as const;

let cachedAv1Support: Promise<boolean> | null = null;

/**
 * True when the current browser can encode AV1 through WebCodecs at 1080p30.
 * The probe is cached forever; the answer doesn't change during a session.
 */
export async function isAv1EncodeSupported(): Promise<boolean> {
	if (cachedAv1Support) return cachedAv1Support;

	cachedAv1Support = (async () => {
		if (typeof VideoEncoder === "undefined") return false;
		try {
			const { supported } = await VideoEncoder.isConfigSupported({
				codec: AV1_CODEC_STRING,
				width: 1920,
				height: 1080,
				bitrate: 5_000_000,
				framerate: 30,
			});
			return supported === true;
		} catch {
			return false;
		}
	})();
	return cachedAv1Support;
}

/** Test-only: reset the cached probe so re-runs re-detect. */
export function __resetAv1SupportCache(): void {
	cachedAv1Support = null;
}
