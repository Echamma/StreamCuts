import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildSceneDetectArgs,
	DEFAULT_SCENE_THRESHOLD,
	parseSceneTimestamps,
} from "./scene-detect-args";

function valueAfter(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

test("scene-detect args: select+showinfo filter, null output, no audio", () => {
	const args = buildSceneDetectArgs({ inputPath: "in.mp4" });
	assert.equal(
		valueAfter(args, "-filter:v"),
		`select='gt(scene,${DEFAULT_SCENE_THRESHOLD})',showinfo`,
	);
	assert.equal(valueAfter(args, "-f"), "null");
	assert.ok(args.includes("-an"));
	assert.equal(args[args.length - 1], "-");
});

test("scene-detect args: threshold is configurable", () => {
	const args = buildSceneDetectArgs({ inputPath: "in.mp4", threshold: 0.6 });
	assert.equal(valueAfter(args, "-filter:v"), "select='gt(scene,0.6)',showinfo");
});

test("parseSceneTimestamps: sorted, de-duped, drops time 0", () => {
	const stderr = [
		"[Parsed_showinfo_1 @ 0x1] n:0 pts:0 pts_time:0.000 duration:...",
		"[Parsed_showinfo_1 @ 0x1] n:30 pts:60000 pts_time:2.002 duration:...",
		"[Parsed_showinfo_1 @ 0x1] n:15 pts:30000 pts_time:1.001 duration:...",
		"[Parsed_showinfo_1 @ 0x1] n:15 pts:30000 pts_time:1.001 duration:...",
	].join("\n");
	assert.deepEqual(parseSceneTimestamps({ stderr }), [1.001, 2.002]);
});

test("parseSceneTimestamps: empty when no scene frames logged", () => {
	assert.deepEqual(parseSceneTimestamps({ stderr: "no matches here" }), []);
});
