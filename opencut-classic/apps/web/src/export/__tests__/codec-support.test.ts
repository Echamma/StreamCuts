import { afterEach, describe, expect, test } from "bun:test";
import {
	__resetAv1SupportCache,
	AV1_CODEC_STRING,
	isAv1EncodeSupported,
} from "@/export/codec-support";

type FakeVideoEncoderCtor = {
	isConfigSupported: (config: {
		codec: string;
	}) => Promise<{ supported: boolean }>;
};

// Bun's test env has no VideoEncoder — install a fake by codec string so tests
// exercise the probe branches without touching real WebCodecs. Using
// defineProperty sidesteps the "you can't reach into globalThis" TS complaint.
function installFakeVideoEncoder({
	answers,
}: {
	answers: Record<string, boolean>;
}): void {
	const fake: FakeVideoEncoderCtor = {
		isConfigSupported: async ({ codec }) => ({
			supported: answers[codec] === true,
		}),
	};
	Object.defineProperty(globalThis, "VideoEncoder", {
		value: fake,
		configurable: true,
		writable: true,
	});
}

function installRejectingVideoEncoder({ error }: { error: Error }): void {
	const fake: FakeVideoEncoderCtor = {
		isConfigSupported: () => Promise.reject(error),
	};
	Object.defineProperty(globalThis, "VideoEncoder", {
		value: fake,
		configurable: true,
		writable: true,
	});
}

function installCountingVideoEncoder(): { calls: () => number } {
	let count = 0;
	const fake: FakeVideoEncoderCtor = {
		isConfigSupported: async () => {
			count++;
			return { supported: true };
		},
	};
	Object.defineProperty(globalThis, "VideoEncoder", {
		value: fake,
		configurable: true,
		writable: true,
	});
	return { calls: () => count };
}

function uninstallFakeVideoEncoder(): void {
	Object.defineProperty(globalThis, "VideoEncoder", {
		value: undefined,
		configurable: true,
		writable: true,
	});
}

describe("isAv1EncodeSupported (DEL-002)", () => {
	afterEach(() => {
		uninstallFakeVideoEncoder();
		__resetAv1SupportCache();
	});

	test("returns false when VideoEncoder is not defined (SSR / node)", async () => {
		expect(await isAv1EncodeSupported()).toBe(false);
	});

	test("returns true when VideoEncoder reports av01.0.05M.08 supported", async () => {
		installFakeVideoEncoder({ answers: { [AV1_CODEC_STRING]: true } });
		expect(await isAv1EncodeSupported()).toBe(true);
	});

	test("returns false when VideoEncoder rejects AV1", async () => {
		installFakeVideoEncoder({ answers: { [AV1_CODEC_STRING]: false } });
		expect(await isAv1EncodeSupported()).toBe(false);
	});

	test("swallows probe errors and returns false", async () => {
		installRejectingVideoEncoder({ error: new Error("boom") });
		expect(await isAv1EncodeSupported()).toBe(false);
	});

	test("caches the probe result across calls", async () => {
		const counter = installCountingVideoEncoder();
		await isAv1EncodeSupported();
		await isAv1EncodeSupported();
		await isAv1EncodeSupported();
		expect(counter.calls()).toBe(1);
	});
});
