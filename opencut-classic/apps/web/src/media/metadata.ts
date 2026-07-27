import type { MediaAsset } from "@/media/types";
import type { ClipAttributes } from "@/services/storage/types";

/**
 * Pure helpers for clip attributes (MED-003): normalising tags/notes/rating and
 * matching assets against a search/smart-bin query. No side effects, no storage,
 * no React — this is the testable core the media-manager facade and the
 * attribute-editor UI both build on.
 *
 * Empty attributes are indistinguishable from "no attributes": {@link normalizeAttributes}
 * returns `undefined` for an all-empty set so a cleared editor persists nothing,
 * and {@link isEmptyAttributes} treats absent and empty alike.
 */

export const MAX_RATING = 5;

/** Clamp any input to an integer star rating in `[0, MAX_RATING]`. */
export function normalizeRating({ value }: { value: number }): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.min(MAX_RATING, Math.max(0, Math.round(value)));
}

/**
 * Trim, drop empties, and de-duplicate case-insensitively (keeping the first
 * casing seen). Order is otherwise preserved.
 */
export function normalizeTags({ tags }: { tags: string[] }): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const raw of tags) {
		const tag = raw.trim();
		if (tag === "") {
			continue;
		}
		const key = tag.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(tag);
	}
	return result;
}

/**
 * Canonical form of an attribute set, or `undefined` when nothing meaningful is
 * set (no tags, blank notes, unrated). Persisting `undefined` keeps a cleared
 * asset identical to one that never had attributes.
 */
export function normalizeAttributes({
	attributes,
}: {
	attributes: ClipAttributes;
}): ClipAttributes | undefined {
	const tags = normalizeTags({ tags: attributes.tags ?? [] });
	const notes = (attributes.notes ?? "").trim();
	const rating = normalizeRating({ value: attributes.rating ?? 0 });

	const next: ClipAttributes = {};
	if (tags.length > 0) {
		next.tags = tags;
	}
	if (notes !== "") {
		next.notes = notes;
	}
	if (rating > 0) {
		next.rating = rating;
	}
	return isEmptyAttributes({ attributes: next }) ? undefined : next;
}

/** True when no tags, no notes, and rating 0/absent. */
export function isEmptyAttributes({
	attributes,
}: {
	attributes: ClipAttributes | undefined;
}): boolean {
	if (!attributes) {
		return true;
	}
	const hasTags = (attributes.tags ?? []).length > 0;
	const hasNotes = (attributes.notes ?? "").trim() !== "";
	const hasRating = (attributes.rating ?? 0) > 0;
	return !hasTags && !hasNotes && !hasRating;
}

/** Add a tag (normalised, de-duplicated) to an attribute set. */
export function addTag({
	attributes,
	tag,
}: {
	attributes: ClipAttributes | undefined;
	tag: string;
}): ClipAttributes {
	const tags = normalizeTags({ tags: [...(attributes?.tags ?? []), tag] });
	return { ...attributes, tags };
}

/** Remove a tag (case-insensitive) from an attribute set. */
export function removeTag({
	attributes,
	tag,
}: {
	attributes: ClipAttributes | undefined;
	tag: string;
}): ClipAttributes {
	const key = tag.trim().toLowerCase();
	const tags = (attributes?.tags ?? []).filter(
		(existing) => existing.toLowerCase() !== key,
	);
	return { ...attributes, tags };
}

export function getAssetTags({ asset }: { asset: MediaAsset }): string[] {
	return asset.attributes?.tags ?? [];
}

export function getAssetRating({ asset }: { asset: MediaAsset }): number {
	return asset.attributes?.rating ?? 0;
}

export interface MediaQuery {
	/** Case-insensitive substring matched against name, notes, and tags. */
	text?: string;
	/** Every listed tag must be present (case-insensitive). */
	tags?: string[];
	/** Minimum star rating. */
	minRating?: number;
}

/** True when `query` is empty (no active filter) — every asset passes. */
export function isEmptyMediaQuery({ query }: { query: MediaQuery }): boolean {
	return (
		(query.text ?? "").trim() === "" &&
		(query.tags ?? []).length === 0 &&
		(query.minRating ?? 0) <= 0
	);
}

/**
 * Whether an asset satisfies a query. An empty query matches everything, so a
 * blank filter bar is a no-op.
 */
export function matchesMediaQuery({
	asset,
	query,
}: {
	asset: MediaAsset;
	query: MediaQuery;
}): boolean {
	const tags = getAssetTags({ asset });

	const text = (query.text ?? "").trim().toLowerCase();
	if (text !== "") {
		const haystack = [asset.name, asset.attributes?.notes ?? "", ...tags]
			.join("\n")
			.toLowerCase();
		if (!haystack.includes(text)) {
			return false;
		}
	}

	const requiredTags = query.tags ?? [];
	if (requiredTags.length > 0) {
		const present = new Set(tags.map((tag) => tag.toLowerCase()));
		for (const required of requiredTags) {
			if (!present.has(required.trim().toLowerCase())) {
				return false;
			}
		}
	}

	const minRating = query.minRating ?? 0;
	if (minRating > 0 && getAssetRating({ asset }) < minRating) {
		return false;
	}

	return true;
}
