import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLoudnessArgs, parseEbur128Summary } from "./loudness-args";

/** A real ffmpeg `ebur128=peak=true` Summary block, plus a trailing per-frame
 * line above it to prove the parser reads only the Summary. */
const SAMPLE_STDERR = `[Parsed_ebur128_0 @ 0x1] t: 2.9   TARGET:-23 LUFS    M: -21.1 S: -21.1     I: -99.9 LUFS       LRA:  99.9 LU  FTPK: -1.0 dBFS  TPK: -1.0 dBFS
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -21.1 LUFS
    Threshold: -31.1 LUFS

  Loudness range:
    LRA:        20.0 LU
    Threshold: -41.1 LUFS
    LRA low:   -41.1 LUFS
    LRA high:  -21.1 LUFS

  True peak:
    Peak:      -18.1 dBFS
`;

test("loudness args: ebur128 with true peak, video skipped, null output", () => {
	const args = buildLoudnessArgs({ inputPath: "clip.mp4" });
	const afIndex = args.indexOf("-af");
	assert.equal(args[afIndex + 1], "ebur128=peak=true");
	assert.ok(args.includes("-vn"));
	assert.equal(args[args.length - 1], "-");
	assert.equal(args[args.length - 2], "null");
});

test("parseEbur128Summary reads integrated, range, true peak, threshold", () => {
	assert.deepEqual(parseEbur128Summary({ stderr: SAMPLE_STDERR }), {
		integratedLufs: -21.1,
		loudnessRangeLu: 20.0,
		truePeakDbfs: -18.1,
		thresholdLufs: -31.1,
	});
});

test("parseEbur128Summary ignores per-frame lines before the Summary", () => {
	// The per-frame line carries I: -99.9 / LRA: 99.9 / TPK -1.0; none leak in.
	const summary = parseEbur128Summary({ stderr: SAMPLE_STDERR });
	assert.equal(summary.integratedLufs, -21.1);
	assert.notEqual(summary.integratedLufs, -99.9);
	assert.notEqual(summary.loudnessRangeLu, 99.9);
});

test("parseEbur128Summary returns nulls when no summary is present", () => {
	assert.deepEqual(parseEbur128Summary({ stderr: "no analysis here" }), {
		integratedLufs: null,
		loudnessRangeLu: null,
		truePeakDbfs: null,
		thresholdLufs: null,
	});
});
