import { describe, expect, test } from "bun:test";
import type {
	AudioTrack,
	SceneTracks,
	TextTrack,
	VideoTrack,
} from "@/timeline";
import { anyTrackSoloed, isTrackAudioSilenced } from "@/timeline/audio-solo";

function videoTrack({
	id,
	muted = false,
	soloed = false,
}: {
	id: string;
	muted?: boolean;
	soloed?: boolean;
}): VideoTrack {
	return {
		id,
		name: id,
		type: "video",
		elements: [],
		muted,
		soloed,
		hidden: false,
	};
}

function audioTrack({
	id,
	muted = false,
	soloed = false,
}: {
	id: string;
	muted?: boolean;
	soloed?: boolean;
}): AudioTrack {
	return { id, name: id, type: "audio", elements: [], muted, soloed };
}

function textTrack({ id }: { id: string }): TextTrack {
	return { id, name: id, type: "text", elements: [], hidden: false };
}

function scene({
	overlay = [],
	main,
	audio = [],
}: {
	overlay?: SceneTracks["overlay"];
	main: VideoTrack;
	audio?: AudioTrack[];
}): SceneTracks {
	return { overlay, main, audio };
}

describe("anyTrackSoloed", () => {
	test("false when no audio track is soloed", () => {
		const tracks = scene({
			main: videoTrack({ id: "main" }),
			audio: [audioTrack({ id: "a" })],
		});
		expect(anyTrackSoloed({ tracks })).toBe(false);
	});

	test("true when the main video track is soloed", () => {
		const tracks = scene({ main: videoTrack({ id: "main", soloed: true }) });
		expect(anyTrackSoloed({ tracks })).toBe(true);
	});

	test("true when an audio track is soloed", () => {
		const tracks = scene({
			main: videoTrack({ id: "main" }),
			audio: [audioTrack({ id: "a", soloed: true })],
		});
		expect(anyTrackSoloed({ tracks })).toBe(true);
	});
});

describe("isTrackAudioSilenced", () => {
	test("non-audio tracks are never silenced by solo/mute", () => {
		expect(
			isTrackAudioSilenced({ track: textTrack({ id: "t" }), soloActive: true }),
		).toBe(false);
	});

	test("an explicitly muted track is silenced regardless of solo", () => {
		expect(
			isTrackAudioSilenced({
				track: audioTrack({ id: "a", muted: true }),
				soloActive: false,
			}),
		).toBe(true);
		expect(
			isTrackAudioSilenced({
				track: audioTrack({ id: "a", muted: true, soloed: true }),
				soloActive: true,
			}),
		).toBe(true);
	});

	test("with solo active, non-soloed tracks are silenced", () => {
		expect(
			isTrackAudioSilenced({
				track: audioTrack({ id: "b" }),
				soloActive: true,
			}),
		).toBe(true);
	});

	test("with solo active, the soloed track stays audible", () => {
		expect(
			isTrackAudioSilenced({
				track: audioTrack({ id: "a", soloed: true }),
				soloActive: true,
			}),
		).toBe(false);
	});

	test("with no solo active, an unmuted track is audible", () => {
		expect(
			isTrackAudioSilenced({
				track: audioTrack({ id: "a" }),
				soloActive: false,
			}),
		).toBe(false);
	});

	test("end-to-end: solo track A silences unmuted track B", () => {
		const tracks = scene({
			main: videoTrack({ id: "main" }),
			audio: [
				audioTrack({ id: "A", soloed: true }),
				audioTrack({ id: "B" }),
			],
		});
		const soloActive = anyTrackSoloed({ tracks });
		expect(
			isTrackAudioSilenced({ track: tracks.audio[0], soloActive }),
		).toBe(false);
		expect(
			isTrackAudioSilenced({ track: tracks.audio[1], soloActive }),
		).toBe(true);
	});
});
