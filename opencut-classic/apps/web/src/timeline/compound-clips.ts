import { getOrderedTimelineTracks } from "@/timeline/scene-tracks-view";
import { cloneAnimations, splitAnimationsAtTime } from "@/animation";
import { getSourceTimeAtClipTime } from "@/retime/resolve";
import type {
	CompoundElement,
	ElementRef,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
} from "@/timeline/types";
import {
	addMediaTime,
	mediaTime,
	subMediaTime,
	TICKS_PER_SECOND,
	type MediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

/**
 * Compound clips (EDIT-007): fold a selection of timeline elements into one
 * nested timeline that behaves like a single clip, and unfold it again.
 *
 * The nested timeline is itself a {@link SceneTracks}, so the renderer can
 * recurse into a compound exactly as it walks the top level, and a compound can
 * contain a compound. Nested elements are stored **relative to the compound's
 * own start**, which is what makes the compound movable: shifting it moves
 * everything inside without touching the children.
 *
 * Everything here is pure arithmetic over the tracks — no editor state, no ids
 * generated, no side effects — so it unit-tests directly and round-trips
 * exactly: decomposing a compound restores the elements the fold consumed.
 */

/** The nested timeline held by a compound clip. */
export interface CompoundContent {
	/** Child elements, with `startTime` relative to the compound's start. */
	tracks: SceneTracks;
	/** Span from the earliest child start to the latest child end. */
	duration: MediaTime;
}

/** A compound folded out of a selection, plus the refs it consumed. */
export interface CompoundPlan {
	/** Where the compound sits on the parent timeline. */
	startTime: MediaTime;
	content: CompoundContent;
	/** The elements that were folded in, to be removed from the parent. */
	sourceRefs: ElementRef[];
}

/** End of an element on its own track's timeline. */
function elementEnd(element: TimelineElement): MediaTime {
	return addMediaTime({ a: element.startTime, b: element.duration });
}

/**
 * Fold the given refs into a compound.
 *
 * The compound starts at the earliest selected element and runs to the latest
 * selected end, so it occupies exactly the span the selection did. Children are
 * rebased to that start and keep their original track (empty tracks are
 * dropped), so relative layering, timing and gaps between them survive the fold
 * untouched.
 *
 * Returns `null` for a selection of fewer than two elements — a compound of one
 * clip adds nesting without adding meaning.
 */
export function planCompound({
	tracks,
	refs,
}: {
	tracks: SceneTracks;
	refs: ElementRef[];
}): CompoundPlan | null {
	const selectedIds = new Set(refs.map((ref) => ref.elementId));
	const ordered = getOrderedTimelineTracks({ tracks });

	let earliest: MediaTime | null = null;
	let latest: MediaTime | null = null;
	let count = 0;
	for (const track of ordered) {
		for (const element of track.elements) {
			if (!selectedIds.has(element.id)) {
				continue;
			}
			count += 1;
			if (earliest === null || element.startTime < earliest) {
				earliest = element.startTime;
			}
			const end = elementEnd(element);
			if (latest === null || end > latest) {
				latest = end;
			}
		}
	}

	if (count < 2 || earliest === null || latest === null) {
		return null;
	}

	const startTime = earliest;
	const duration = subMediaTime({ a: latest, b: startTime });

	// Rebuild each source track carrying only the selected elements, rebased to
	// the compound's start; tracks that contributed nothing are dropped. Each
	// bucket is written out rather than indexed dynamically, so every element
	// keeps its concrete type instead of collapsing to a union.
	const isSelected = (element: TimelineElement) => selectedIds.has(element.id);

	const nested: SceneTracks = {
		video: tracks.video
			.map((track) => ({
				...track,
				elements: track.elements.filter(isSelected).map((element) => ({
					...element,
					startTime: subMediaTime({ a: element.startTime, b: startTime }),
				})),
				transitions: track.transitions?.filter(
					(transition) =>
						selectedIds.has(transition.fromElementId) &&
						selectedIds.has(transition.toElementId),
				),
			}))
			.filter((track) => track.elements.length > 0),
		text: tracks.text
			.map((track) => ({
				...track,
				elements: track.elements.filter(isSelected).map((element) => ({
					...element,
					startTime: subMediaTime({ a: element.startTime, b: startTime }),
				})),
			}))
			.filter((track) => track.elements.length > 0),
		graphic: tracks.graphic
			.map((track) => ({
				...track,
				elements: track.elements.filter(isSelected).map((element) => ({
					...element,
					startTime: subMediaTime({ a: element.startTime, b: startTime }),
				})),
			}))
			.filter((track) => track.elements.length > 0),
		effect: tracks.effect
			.map((track) => ({
				...track,
				elements: track.elements.filter(isSelected).map((element) => ({
					...element,
					startTime: subMediaTime({ a: element.startTime, b: startTime }),
				})),
			}))
			.filter((track) => track.elements.length > 0),
		audio: tracks.audio
			.map((track) => ({
				...track,
				elements: track.elements.filter(isSelected).map((element) => ({
					...element,
					startTime: subMediaTime({ a: element.startTime, b: startTime }),
				})),
			}))
			.filter((track) => track.elements.length > 0),
	};

	// Which refs the fold consumed, in track order.
	const sourceRefs: ElementRef[] = [];
	for (const track of ordered) {
		for (const element of track.elements) {
			if (selectedIds.has(element.id)) {
				sourceRefs.push({ trackId: track.id, elementId: element.id });
			}
		}
	}

	return {
		startTime,
		content: { tracks: nested, duration },
		sourceRefs,
	};
}

/** An element restored from a compound, with the track it belongs on. */
export interface DecomposedElement {
	trackId: string;
	element: TimelineElement;
}

/**
 * Unfold a compound back onto the parent timeline at `startTime`, undoing
 * {@link planCompound}: every child's start is rebased from compound-relative
 * back to absolute. Children whose rebased start would fall before zero are
 * clamped, which can only happen if a caller places a compound at a negative
 * time.
 */
export function decomposeCompound({
	content,
	startTime,
	trimStart = ZERO_MEDIA_TIME,
	duration = content.duration,
}: {
	content: CompoundContent;
	startTime: MediaTime;
	trimStart?: MediaTime;
	duration?: MediaTime;
}): DecomposedElement[] {
	const restored: DecomposedElement[] = [];
	const windowStart = trimStart;
	const windowEnd = trimStart + duration;
	for (const track of getOrderedTimelineTracks({ tracks: content.tracks })) {
		for (const element of track.elements) {
			const visibleStart = Math.max(windowStart, element.startTime);
			const visibleEnd = Math.min(
				windowEnd,
				element.startTime + element.duration,
			);
			if (visibleEnd <= visibleStart) continue;
			const left = visibleStart - element.startTime;
			const right = element.startTime + element.duration - visibleEnd;
			const sourceDelta = (clipDelta: number) =>
				mediaTime({
					ticks: Math.round(
						getSourceTimeAtClipTime({
							clipTime: clipDelta / TICKS_PER_SECOND,
							retime:
								element.type === "audio" || element.type === "video"
									? element.retime
									: undefined,
						}) * TICKS_PER_SECOND,
					),
				});
			let animations = element.animations;
			if (left > 0) {
				animations = splitAnimationsAtTime({
					animations,
					splitTime: mediaTime({ ticks: left }),
				}).rightAnimations;
			}
			if (right > 0) {
				animations = splitAnimationsAtTime({
					animations,
					splitTime: mediaTime({ ticks: visibleEnd - visibleStart }),
				}).leftAnimations;
			}
			const absolute = mediaTime({
				ticks: startTime + visibleStart - trimStart,
			});
			restored.push({
				trackId: track.id,
				element: {
					...element,
					startTime: absolute > ZERO_MEDIA_TIME ? absolute : ZERO_MEDIA_TIME,
					duration: mediaTime({ ticks: visibleEnd - visibleStart }),
					trimStart: addMediaTime({
						a: element.trimStart,
						b: sourceDelta(left),
					}),
					trimEnd: addMediaTime({
						a: element.trimEnd,
						b: sourceDelta(right),
					}),
					animations,
					markers: element.markers
						?.filter(
							(marker) =>
								marker.time >= left &&
								marker.time < visibleEnd - element.startTime,
						)
						.map((marker) => ({
							...marker,
							time: subMediaTime({
								a: marker.time,
								b: mediaTime({ ticks: left }),
							}),
						})),
				},
			});
		}
	}
	return restored;
}

/**
 * Total span of a compound's children, recomputed from its content. Used after
 * editing inside a compound, where a child may now extend past the duration
 * recorded when it was folded.
 */
export function measureCompoundDuration({
	content,
}: {
	content: CompoundContent;
}): MediaTime {
	let latest: MediaTime = ZERO_MEDIA_TIME;
	for (const track of getOrderedTimelineTracks({ tracks: content.tracks })) {
		for (const element of track.elements) {
			const end = elementEnd(element);
			if (end > latest) {
				latest = end;
			}
		}
	}
	return latest;
}

/** A fresh empty nested timeline, for constructing a compound with no children. */
export function emptyCompoundTracks(): SceneTracks {
	return { video: [], text: [], graphic: [], effect: [], audio: [] };
}

/** Fold a selection into a new top video layer in one immutable edit. */
export function makeCompoundInTracks({
	tracks,
	refs,
	id,
	trackId,
	name,
}: {
	tracks: SceneTracks;
	refs: ElementRef[];
	id: string;
	trackId: string;
	name: string;
}): { tracks: SceneTracks; compound: CompoundElement; trackId: string } | null {
	const plan = planCompound({ tracks, refs });
	if (!plan) return null;
	const selected = new Set(
		plan.sourceRefs.map((ref) => `${ref.trackId}\0${ref.elementId}`),
	);
	const removedIds = new Set(plan.sourceRefs.map((ref) => ref.elementId));
	const removeSelected = <T extends TimelineTrack>(track: T): T =>
		({
			...track,
			elements: track.elements.filter(
				(element) => !selected.has(`${track.id}\0${element.id}`),
			),
			...(track.type === "video" && {
				transitions: track.transitions?.filter(
					(transition) =>
						!removedIds.has(transition.fromElementId) &&
						!removedIds.has(transition.toElementId),
				),
			}),
		}) as T;
	const compound: CompoundElement = {
		id,
		name,
		type: "compound",
		startTime: plan.startTime,
		duration: plan.content.duration,
		sourceDuration: plan.content.duration,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {},
		tracks: plan.content.tracks,
	};
	return {
		trackId,
		compound,
		tracks: {
			video: [
				...tracks.video.map(removeSelected),
				{
					id: trackId,
					name,
					type: "video",
					elements: [compound],
					transitions: [],
					muted: false,
					hidden: false,
				},
			],
			text: tracks.text.map(removeSelected),
			graphic: tracks.graphic.map(removeSelected),
			effect: tracks.effect.map(removeSelected),
			audio: tracks.audio.map(removeSelected),
		},
	};
}

/** Replace a compound with its visible children, restoring their track bands. */
export function decomposeCompoundInTracks({
	tracks,
	trackId,
	elementId,
}: {
	tracks: SceneTracks;
	trackId: string;
	elementId: string;
}): SceneTracks | null {
	const outerTrack = tracks.video.find((track) => track.id === trackId);
	const compound = outerTrack?.elements.find(
		(element) => element.id === elementId,
	);
	if (compound?.type !== "compound") return null;
	const restored = decomposeCompound({
		content: {
			tracks: compound.tracks,
			duration: compound.sourceDuration ?? compound.duration,
		},
		startTime: compound.startTime,
		trimStart: compound.trimStart,
		duration: compound.duration,
	});
	const restoredIds = new Set(restored.map(({ element }) => element.id));
	const withoutOuter: SceneTracks = {
		...tracks,
		video: tracks.video
			.map((track) =>
				track.id !== trackId
					? track
					: {
							...track,
							elements: track.elements.filter(
								(element) => element.id !== elementId,
							),
							transitions: track.transitions?.filter(
								(transition) =>
									transition.fromElementId !== elementId &&
									transition.toElementId !== elementId,
							),
						},
			)
			.filter(
				(track, index) =>
					index === 0 || track.id !== trackId || track.elements.length > 0,
			),
	};
	const restoreBand = <T extends TimelineTrack>({
		parent,
		nested,
	}: {
		parent: T[];
		nested: T[];
	}): T[] => {
		const result = [...parent];
		for (const childTrack of nested) {
			// Every restored element comes from this child track; its concrete
			// element type is unchanged by the time/trim transformation.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			const elements = restored
				.filter((item) => item.trackId === childTrack.id)
				.map((item) => item.element) as T["elements"];
			if (elements.length === 0) continue;
			const index = result.findIndex((track) => track.id === childTrack.id);
			const transitions =
				childTrack.type === "video"
					? childTrack.transitions?.filter(
							(transition) =>
								restoredIds.has(transition.fromElementId) &&
								restoredIds.has(transition.toElementId),
						)
					: undefined;
			if (index < 0) {
				result.push({
					...childTrack,
					elements,
					...(childTrack.type === "video" && { transitions }),
				} as T);
			} else {
				const existing = result[index];
				result[index] = {
					...existing,
					elements: [...existing.elements, ...elements],
					...(existing.type === "video" && {
						transitions: [
							...(existing.transitions ?? []),
							...(transitions ?? []),
						],
					}),
				} as T;
			}
		}
		return result;
	};
	return {
		video: restoreBand({
			parent: withoutOuter.video,
			nested: compound.tracks.video,
		}),
		text: restoreBand({
			parent: withoutOuter.text,
			nested: compound.tracks.text,
		}),
		graphic: restoreBand({
			parent: withoutOuter.graphic,
			nested: compound.tracks.graphic,
		}),
		effect: restoreBand({
			parent: withoutOuter.effect,
			nested: compound.tracks.effect,
		}),
		audio: restoreBand({
			parent: withoutOuter.audio,
			nested: compound.tracks.audio,
		}),
	};
}

/** Clone a compound's content for paste/duplicate, preserving internal links. */
export function cloneCompoundTracks({
	tracks,
	generateId,
	activeIds = new Set<string>(),
}: {
	tracks: SceneTracks;
	generateId: () => string;
	activeIds?: ReadonlySet<string>;
}): SceneTracks {
	const elementIds = new Map<string, string>();
	const linkIds = new Map<string, string>();
	const groupIds = new Map<string, string>();
	const remap = ({ map, id }: { map: Map<string, string>; id: string }) => {
		let next = map.get(id);
		if (!next) {
			next = generateId();
			map.set(id, next);
		}
		return next;
	};
	for (const track of getOrderedTimelineTracks({ tracks })) {
		for (const element of track.elements)
			remap({ map: elementIds, id: element.id });
	}
	const cloneElement = <T extends TimelineElement>(element: T): T => {
		const shared = {
			...element,
			id: remap({ map: elementIds, id: element.id }),
			linkId: element.linkId
				? remap({ map: linkIds, id: element.linkId })
				: undefined,
			groupId: element.groupId
				? remap({ map: groupIds, id: element.groupId })
				: undefined,
			animations: cloneAnimations({
				animations: element.animations,
				shouldRegenerateKeyframeIds: true,
			}),
		};
		if (element.type !== "compound") return shared as T;
		if (activeIds.has(element.id)) {
			return { ...shared, tracks: emptyCompoundTracks() } as T;
		}
		const ancestry = new Set(activeIds);
		ancestry.add(element.id);
		return {
			...shared,
			tracks: cloneCompoundTracks({
				tracks: element.tracks,
				generateId,
				activeIds: ancestry,
			}),
		} as T;
	};
	const cloneTransitions = (
		transitions: SceneTracks["video"][number]["transitions"],
	) =>
		transitions?.map((transition) => ({
			...transition,
			id: generateId(),
			fromElementId: remap({ map: elementIds, id: transition.fromElementId }),
			toElementId: remap({ map: elementIds, id: transition.toElementId }),
		}));
	return {
		video: tracks.video.map((track) => ({
			...track,
			id: generateId(),
			elements: track.elements.map(cloneElement),
			transitions: cloneTransitions(track.transitions),
		})),
		text: tracks.text.map((track) => ({
			...track,
			id: generateId(),
			elements: track.elements.map(cloneElement),
		})),
		graphic: tracks.graphic.map((track) => ({
			...track,
			id: generateId(),
			elements: track.elements.map(cloneElement),
		})),
		effect: tracks.effect.map((track) => ({
			...track,
			id: generateId(),
			elements: track.elements.map(cloneElement),
		})),
		audio: tracks.audio.map((track) => ({
			...track,
			id: generateId(),
			elements: track.elements.map(cloneElement),
		})),
	};
}
