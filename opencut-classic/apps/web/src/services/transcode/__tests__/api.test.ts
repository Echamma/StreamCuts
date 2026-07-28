import { afterEach, describe, expect, test } from "bun:test";
import {
	requestProRes,
	requestProxy,
	transcodeOutputUrl,
} from "@/services/transcode/api";

// The client imports only a type from `@/long-to-short/api`, so no @/wasm stub
// is needed. We stub `fetch` to capture the request and return canned responses.

interface Captured {
	url: string;
	init: RequestInit | undefined;
}

function stubFetch(response: Response): { calls: Captured[] } {
	const calls: Captured[] = [];
	// Positional params intentionally: this replaces the global `fetch`, whose
	// signature is positional.
	// eslint-disable-next-line opencut/prefer-object-params
	const fetchStub = async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		calls.push({ url: String(input), init });
		return response;
	};
	Object.defineProperty(globalThis, "fetch", {
		value: fetchStub,
		configurable: true,
		writable: true,
	});
	return { calls };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
	Object.defineProperty(globalThis, "fetch", {
		value: originalFetch,
		configurable: true,
		writable: true,
	});
});

function jsonResponse({
	body,
	status = 200,
}: {
	body: unknown;
	status?: number;
}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function clip(): File {
	return new File(["fake-bytes"], "clip.mp4", { type: "video/mp4" });
}

function bodyOf(init: RequestInit | undefined): FormData {
	const body = init?.body;
	if (!(body instanceof FormData)) {
		throw new Error("expected FormData body");
	}
	return body;
}

const OK_RESULT = {
	id: "abc",
	fileName: "abc.mov",
	video: {
		videoCodec: "prores",
		audioCodec: "pcm_s16le",
		width: 1280,
		height: 720,
		durationSeconds: 2,
	},
};

describe("requestProxy", () => {
	test("POSTs the file (and height) to the proxy endpoint", async () => {
		const { calls } = stubFetch(
			jsonResponse({ body: { ...OK_RESULT, fileName: "abc.mp4" } }),
		);
		const result = await requestProxy({ file: clip(), height: 720 });

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("http://localhost:4000/api/transcode/proxy");
		expect(calls[0].init?.method).toBe("POST");
		const form = bodyOf(calls[0].init);
		expect(form.get("video")).toBeInstanceOf(File);
		expect(form.get("height")).toBe("720");
		expect(result.fileName).toBe("abc.mp4");
	});

	test("omits height when not given", async () => {
		const { calls } = stubFetch(jsonResponse({ body: OK_RESULT }));
		await requestProxy({ file: clip() });
		expect(bodyOf(calls[0].init).get("height")).toBeNull();
	});
});

describe("requestProRes", () => {
	test("POSTs to the prores endpoint with the profile", async () => {
		const { calls } = stubFetch(jsonResponse({ body: OK_RESULT }));
		const result = await requestProRes({ file: clip(), profile: "hq" });

		expect(calls[0].url).toBe("http://localhost:4000/api/transcode/prores");
		expect(bodyOf(calls[0].init).get("profile")).toBe("hq");
		expect(result.video.videoCodec).toBe("prores");
		expect(result.video.height).toBe(720);
	});
});

describe("error handling", () => {
	test("throws the backend message on a non-ok response", async () => {
		stubFetch(jsonResponse({ body: { message: "Unknown ProRes profile: nope" }, status: 400 }));
		await expect(requestProRes({ file: clip() })).rejects.toThrow(
			"Unknown ProRes profile: nope",
		);
	});

	test("throws on a malformed success payload", async () => {
		stubFetch(jsonResponse({ body: { nope: true } }));
		await expect(requestProxy({ file: clip() })).rejects.toThrow(
			"Malformed transcode response.",
		);
	});
});

describe("transcodeOutputUrl", () => {
	test("builds the download URL, encoding the file name", () => {
		expect(transcodeOutputUrl({ fileName: "a b.mov" })).toBe(
			"http://localhost:4000/api/transcode/outputs/a%20b.mov",
		);
	});
});
