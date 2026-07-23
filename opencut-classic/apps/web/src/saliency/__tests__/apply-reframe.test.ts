import { describe, expect, mock, test } from "bun:test";
import type {
	ChannelData,
	ElementAnimations,
	ScalarChannel,
} from "@/animation/types";
import { isLeafChannelData } from "@/animation/channel-data";

// `@/wasm` MediaTime construction is wasm-bindgen backed; its bundler-target
// module can't boot under `bun test`, so stub `mediaTime` to a bare tick number
// (the pure merge helper never inspects the branded value).
mock.module("@/wasm", () => ({
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
}));

const { mediaTime } = await import("@/wasm");

import type { ReframeChannels } from "@/saliency/runner";
import {
	mergeReframeAnimations,
	reframeKeyCount,
} from "@/saliency/apply-reframe";

function scalarChannel({ values }: { values: number[] }): ScalarChannel {
	return {
		keys: values.map((value, index) => ({
			id: `k-${index}`,
			time: mediaTime({ ticks: index }),
			value,
			segmentToNext: "linear",
			tangentMode: "auto",
		})),
	};
}

function channels({
	xs,
	ys,
}: {
	xs: number[];
	ys: number[];
}): ReframeChannels {
	return {
		"reframe.x": scalarChannel({ values: xs }),
		"reframe.y": scalarChannel({ values: ys }),
	};
}

/** Read numeric key values off an animation channel without a type assertion. */
function numericValues({
	channel,
}: {
	channel: ChannelData | undefined;
}): number[] {
	if (!isLeafChannelData(channel)) return [];
	return channel.keys
		.map((key) => key.value)
		.filter((value): value is number => typeof value === "number");
}

describe("mergeReframeAnimations (EDIT-016)", () => {
	test("writes reframe.x/.y channels onto an element with no prior animation", () => {
		const result = mergeReframeAnimations({
			animations: undefined,
			channels: channels({ xs: [0.5, 0.6], ys: [0.5, 0.4] }),
		});
		expect(Object.keys(result).sort()).toEqual(["reframe.x", "reframe.y"]);
		expect(numericValues({ channel: result["reframe.x"] })).toEqual([0.5, 0.6]);
	});

	test("preserves unrelated animated properties", () => {
		const prior: ElementAnimations = {
			opacity: scalarChannel({ values: [1, 0] }),
			"transform.positionX": scalarChannel({ values: [0, 100] }),
		};
		const result = mergeReframeAnimations({
			animations: prior,
			channels: channels({ xs: [0.5], ys: [0.5] }),
		});
		expect(result.opacity).toBe(prior.opacity);
		expect(result["transform.positionX"]).toBe(prior["transform.positionX"]);
		expect(result["reframe.x"]).toBeDefined();
	});

	test("overwrites any pre-existing reframe channels", () => {
		const prior: ElementAnimations = {
			"reframe.x": scalarChannel({ values: [0.1] }),
			"reframe.y": scalarChannel({ values: [0.1] }),
		};
		const result = mergeReframeAnimations({
			animations: prior,
			channels: channels({ xs: [0.9, 0.8], ys: [0.2, 0.3] }),
		});
		expect(numericValues({ channel: result["reframe.x"] })).toEqual([0.9, 0.8]);
	});

	test("clamps out-of-range values into [0,1]", () => {
		const result = mergeReframeAnimations({
			animations: undefined,
			channels: channels({ xs: [-0.3, 1.4], ys: [2, -1] }),
		});
		expect(numericValues({ channel: result["reframe.x"] })).toEqual([0, 1]);
		expect(numericValues({ channel: result["reframe.y"] })).toEqual([1, 0]);
	});

	test("reframeKeyCount reports the x-channel key count", () => {
		expect(
			reframeKeyCount({ channels: channels({ xs: [0.5, 0.5, 0.5], ys: [0.5, 0.5, 0.5] }) }),
		).toBe(3);
	});
});
