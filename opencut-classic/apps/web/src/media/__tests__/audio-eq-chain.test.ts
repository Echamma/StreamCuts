import { expect, test } from "bun:test";
import { buildEqChain } from "@/media/audio-eq-chain";
import type { EqBand } from "@/timeline/audio-eq";

test("Web Audio nodes use the resolved band order and parameters", () => {
	const nodes: Array<{
		type: string;
		frequency: { value: number };
		gain: { value: number };
		Q: { value: number };
	}> = [];
	const context = {
		createBiquadFilter() {
			const node = {
				type: "allpass",
				frequency: { value: 0 },
				gain: { value: 0 },
				Q: { value: 0 },
			};
			nodes.push(node);
			return node;
		},
	};
	const bands: EqBand[] = [
		{ type: "lowshelf", frequency: 120, gainDb: 0, q: 1 },
		{ type: "peaking", frequency: 1500, gainDb: -12, q: 1.5 },
		{ type: "highshelf", frequency: 12000, gainDb: 3, q: 1 },
	];
	// Test double implements exactly the node properties this helper sets.
	const result = buildEqChain({
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		context: context as unknown as BaseAudioContext,
		bands,
	});
	expect(result).toHaveLength(2);
	expect(
		nodes.map((node) => [
			node.type,
			node.frequency.value,
			node.gain.value,
			node.Q.value,
		]),
	).toEqual([
		["peaking", 1500, -12, 1.5],
		["highshelf", 12000, 3, 1],
	]);
});
