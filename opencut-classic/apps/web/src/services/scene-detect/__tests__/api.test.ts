import { afterEach, describe, expect, test } from "bun:test";
import { requestSceneDetect } from "@/services/scene-detect/api";

// Imports only a type from @/long-to-short/api → no @/wasm stub needed.

interface Captured {
	url: string;
	init: RequestInit | undefined;
}

function stubFetch(response: Response): { calls: Captured[] } {
	const calls: Captured[] = [];
	// Positional params intentionally — this replaces the global `fetch`.
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
	return new File(["bytes"], "clip.mp4", { type: "video/mp4" });
}

function bodyOf(init: RequestInit | undefined): FormData {
	const body = init?.body;
	if (!(body instanceof FormData)) {
		throw new Error("expected FormData body");
	}
	return body;
}

describe("requestSceneDetect", () => {
	test("POSTs the file (and threshold) and returns the cuts", async () => {
		const { calls } = stubFetch(jsonResponse({ body: { cuts: [1, 2, 3.5] } }));
		const result = await requestSceneDetect({ file: clip(), threshold: 0.3 });

		expect(calls[0].url).toBe("http://localhost:4000/api/scene-detect");
		expect(calls[0].init?.method).toBe("POST");
		const form = bodyOf(calls[0].init);
		expect(form.get("video")).toBeInstanceOf(File);
		expect(form.get("threshold")).toBe("0.3");
		expect(result.cuts).toEqual([1, 2, 3.5]);
	});

	test("omits threshold when not given", async () => {
		const { calls } = stubFetch(jsonResponse({ body: { cuts: [] } }));
		await requestSceneDetect({ file: clip() });
		expect(bodyOf(calls[0].init).get("threshold")).toBeNull();
	});

	test("throws the backend message on a non-ok response", async () => {
		stubFetch(jsonResponse({ body: { message: "bad video" }, status: 400 }));
		await expect(requestSceneDetect({ file: clip() })).rejects.toThrow(
			"bad video",
		);
	});

	test("throws on a malformed payload", async () => {
		stubFetch(jsonResponse({ body: { cuts: ["nope"] } }));
		await expect(requestSceneDetect({ file: clip() })).rejects.toThrow(
			"Malformed scene-detect response.",
		);
	});
});
