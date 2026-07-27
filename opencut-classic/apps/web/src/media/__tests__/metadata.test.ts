import { describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import {
	addTag,
	getAssetRating,
	getAssetTags,
	isEmptyAttributes,
	isEmptyMediaQuery,
	matchesMediaQuery,
	MAX_RATING,
	normalizeAttributes,
	normalizeRating,
	normalizeTags,
	removeTag,
} from "@/media/metadata";
import type { ClipAttributes } from "@/services/storage/types";

// metadata.ts imports only types, so no @/wasm stub is needed. The helpers read
// only `name` and `attributes`, so a bare bag stands in for a full MediaAsset.
function asset({
	name = "clip",
	attributes,
}: {
	name?: string;
	attributes?: ClipAttributes;
}): MediaAsset {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test stub: only name/attributes are read
	return { name, attributes } as MediaAsset;
}

describe("normalizeRating", () => {
	test("clamps to an integer in [0, MAX_RATING]", () => {
		expect(normalizeRating({ value: 3 })).toBe(3);
		expect(normalizeRating({ value: 3.4 })).toBe(3);
		expect(normalizeRating({ value: 3.6 })).toBe(4);
		expect(normalizeRating({ value: -2 })).toBe(0);
		expect(normalizeRating({ value: 99 })).toBe(MAX_RATING);
		expect(normalizeRating({ value: Number.NaN })).toBe(0);
	});
});

describe("normalizeTags", () => {
	test("trims, drops empties, and de-dupes case-insensitively", () => {
		expect(
			normalizeTags({ tags: [" Hero ", "hero", "", "B-roll", "b-roll", "Cut"] }),
		).toEqual(["Hero", "B-roll", "Cut"]);
	});
});

describe("normalizeAttributes", () => {
	test("returns undefined for an all-empty set", () => {
		expect(
			normalizeAttributes({ attributes: { tags: [" "], notes: "  ", rating: 0 } }),
		).toBeUndefined();
		expect(normalizeAttributes({ attributes: {} })).toBeUndefined();
	});

	test("keeps only the meaningful, normalised fields", () => {
		expect(
			normalizeAttributes({
				attributes: { tags: ["a", "a"], notes: "  hi ", rating: 2.6 },
			}),
		).toEqual({ tags: ["a"], notes: "hi", rating: 3 });
	});

	test("drops a zero rating and blank notes but keeps tags", () => {
		expect(
			normalizeAttributes({ attributes: { tags: ["x"], notes: "", rating: 0 } }),
		).toEqual({ tags: ["x"] });
	});
});

describe("isEmptyAttributes", () => {
	test("absent and all-empty both count as empty", () => {
		expect(isEmptyAttributes({ attributes: undefined })).toBe(true);
		expect(isEmptyAttributes({ attributes: { tags: [], notes: "" } })).toBe(true);
		expect(isEmptyAttributes({ attributes: { rating: 0 } })).toBe(true);
	});

	test("any set field makes it non-empty", () => {
		expect(isEmptyAttributes({ attributes: { rating: 1 } })).toBe(false);
		expect(isEmptyAttributes({ attributes: { tags: ["a"] } })).toBe(false);
	});
});

describe("addTag / removeTag", () => {
	test("addTag appends without duplicating", () => {
		expect(addTag({ attributes: { tags: ["a"] }, tag: "b" }).tags).toEqual([
			"a",
			"b",
		]);
		expect(addTag({ attributes: { tags: ["a"] }, tag: "A" }).tags).toEqual(["a"]);
	});

	test("removeTag drops case-insensitively", () => {
		expect(
			removeTag({ attributes: { tags: ["Hero", "Cut"] }, tag: "hero" }).tags,
		).toEqual(["Cut"]);
	});

	test("works from undefined attributes", () => {
		expect(addTag({ attributes: undefined, tag: "a" }).tags).toEqual(["a"]);
		expect(removeTag({ attributes: undefined, tag: "a" }).tags).toEqual([]);
	});
});

describe("matchesMediaQuery / isEmptyMediaQuery", () => {
	const heroClip = asset({
		name: "Opening Hero Shot.mp4",
		attributes: { tags: ["hero", "b-roll"], notes: "golden hour", rating: 4 },
	});

	test("an empty query matches everything", () => {
		expect(isEmptyMediaQuery({ query: {} })).toBe(true);
		expect(matchesMediaQuery({ asset: heroClip, query: {} })).toBe(true);
	});

	test("text matches name, notes, or tags (case-insensitive)", () => {
		expect(
			matchesMediaQuery({ asset: heroClip, query: { text: "hero" } }),
		).toBe(true);
		expect(
			matchesMediaQuery({ asset: heroClip, query: { text: "GOLDEN" } }),
		).toBe(true);
		expect(
			matchesMediaQuery({ asset: heroClip, query: { text: "b-roll" } }),
		).toBe(true);
		expect(
			matchesMediaQuery({ asset: heroClip, query: { text: "missing" } }),
		).toBe(false);
	});

	test("all required tags must be present", () => {
		expect(
			matchesMediaQuery({ asset: heroClip, query: { tags: ["hero"] } }),
		).toBe(true);
		expect(
			matchesMediaQuery({ asset: heroClip, query: { tags: ["hero", "nope"] } }),
		).toBe(false);
	});

	test("minRating filters below the threshold", () => {
		expect(
			matchesMediaQuery({ asset: heroClip, query: { minRating: 4 } }),
		).toBe(true);
		expect(
			matchesMediaQuery({ asset: heroClip, query: { minRating: 5 } }),
		).toBe(false);
	});

	test("an unrated / untagged asset fails a restrictive query", () => {
		const plain = asset({ name: "clip.mp4" });
		expect(getAssetTags({ asset: plain })).toEqual([]);
		expect(getAssetRating({ asset: plain })).toBe(0);
		expect(matchesMediaQuery({ asset: plain, query: { minRating: 1 } })).toBe(
			false,
		);
	});
});
