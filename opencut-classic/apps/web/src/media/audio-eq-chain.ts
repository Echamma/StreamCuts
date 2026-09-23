import { EQ_FLAT_EPSILON_DB, type EqBand } from "@/timeline/audio-eq";

/** Build the same three-band filter order for live playback and offline renders. */
export function buildEqChain({
	context,
	bands,
}: {
	context: BaseAudioContext;
	bands: EqBand[];
}): BiquadFilterNode[] {
	return bands
		.filter((band) => Math.abs(band.gainDb) >= EQ_FLAT_EPSILON_DB)
		.map((band) => {
			const node = context.createBiquadFilter();
			node.type = band.type;
			node.frequency.value = band.frequency;
			node.gain.value = band.gainDb;
			node.Q.value = band.q;
			return node;
		});
}
