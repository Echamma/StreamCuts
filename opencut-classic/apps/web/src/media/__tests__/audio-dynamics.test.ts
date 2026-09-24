import { expect, test } from "bun:test";
import {
	DEFAULT_TRACK_COMPRESSOR,
	resolveTrackCompressor,
} from "../audio-dynamics";

test("old projects leave track compression disabled", () => {
	expect(resolveTrackCompressor(undefined)).toEqual(DEFAULT_TRACK_COMPRESSOR);
});

test("saved compressor values are bounded to Web Audio's legal ranges", () => {
	expect(
		resolveTrackCompressor({
			enabled: true,
			thresholdDb: -200,
			ratio: 50,
			attackSeconds: Number.NaN,
			releaseSeconds: -1,
			kneeDb: 80,
		}),
	).toEqual({
		enabled: true,
		thresholdDb: -100,
		ratio: 20,
		attackSeconds: DEFAULT_TRACK_COMPRESSOR.attackSeconds,
		releaseSeconds: 0,
		kneeDb: 40,
	});
});
