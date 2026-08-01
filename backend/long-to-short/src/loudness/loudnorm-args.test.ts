import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildLoudnormApplyArgs,
	buildLoudnormMeasureArgs,
	parseLoudnormStats,
} from "./loudnorm-args";

/** A real `loudnorm=print_format=json` stats block (tab-indented, string
 * values), with a log line above it to prove the parser locates the block. */
const SAMPLE_STDERR = `[Parsed_loudnorm_1 @ 0x1]
{
\t"input_i" : "-41.75",
\t"input_tp" : "-38.06",
\t"input_lra" : "0.00",
\t"input_thresh" : "-51.75",
\t"output_i" : "-13.95",
\t"target_offset" : "-0.05"
}
`;

function valueAfter(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

test("measure args: loudnorm with json stats, target defaults, null output", () => {
	const args = buildLoudnormMeasureArgs({ inputPath: "in.wav" });
	assert.equal(
		valueAfter(args, "-af"),
		"loudnorm=I=-14:TP=-1:LRA=11:print_format=json",
	);
	assert.ok(args.includes("-vn"));
	assert.equal(args[args.length - 1], "-");
});

test("measure args: target overrides flow into the filter", () => {
	const args = buildLoudnormMeasureArgs({
		inputPath: "in.wav",
		target: { targetLufs: -23, targetTruePeak: -2, targetLra: 7 },
	});
	assert.equal(
		valueAfter(args, "-af"),
		"loudnorm=I=-23:TP=-2:LRA=7:print_format=json",
	);
});

test("parseLoudnormStats reads the measured input values", () => {
	assert.deepEqual(parseLoudnormStats({ stderr: SAMPLE_STDERR }), {
		inputI: -41.75,
		inputTp: -38.06,
		inputLra: 0,
		inputThresh: -51.75,
		targetOffset: -0.05,
	});
});

test("parseLoudnormStats throws when stats are absent", () => {
	assert.throws(
		() => parseLoudnormStats({ stderr: "no json here" }),
		/loudnorm stats not found/,
	);
});

test("apply args: second pass carries measured_* and linear=true, writes PCM", () => {
	const measured = parseLoudnormStats({ stderr: SAMPLE_STDERR });
	const args = buildLoudnormApplyArgs({
		inputPath: "in.wav",
		outputPath: "out.wav",
		measured,
	});
	const filter = valueAfter(args, "-af") ?? "";
	assert.ok(filter.includes("measured_I=-41.75"));
	assert.ok(filter.includes("measured_thresh=-51.75"));
	assert.ok(filter.includes("offset=-0.05"));
	assert.ok(filter.includes("linear=true"));
	assert.equal(valueAfter(args, "-c:a"), "pcm_s16le");
	assert.equal(args[args.length - 1], "out.wav");
});
