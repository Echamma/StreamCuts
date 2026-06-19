import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { EditorCore } from "@/core";

const SNAPSHOT_UNSET = Symbol("snapshotUnset");

function isShallowEqual({
	a,
	b,
}: {
	a: unknown;
	b: unknown;
}): boolean {
	if (Object.is(a, b)) return true;
	if (!Array.isArray(a) || !Array.isArray(b)) return false;
	if (a.length !== b.length) return false;
	return a.every((item, i) => Object.is(item, b[i]));
}

const subscribeNone = () => () => {};

export function useEditor(): EditorCore;
export function useEditor<T>(selector: (editor: EditorCore) => T): T;
export function useEditor<T>(
	selector?: (editor: EditorCore) => T,
): EditorCore | T {
	const editor = useMemo(() => EditorCore.getInstance(), []);
	const snapshotCacheRef = useRef<T | typeof SNAPSHOT_UNSET>(SNAPSHOT_UNSET);

	const subscribeAll = useCallback(
		(onChange: () => void) => {
			const unsubscribers = [
				editor.playback.subscribe(onChange),
				editor.timeline.subscribe(onChange),
				editor.scenes.subscribe(onChange),
				editor.project.subscribe(onChange),
				editor.media.subscribe(onChange),
				editor.renderer.subscribe(onChange),
				editor.selection.subscribe(onChange),
				editor.clipboard.subscribe(onChange),
				editor.diagnostics.subscribe(onChange),
			];
			return () => {
				unsubscribers.forEach((unsubscribe) => {
					unsubscribe();
				});
			};
		},
		[editor],
	);

	const getSnapshot = useCallback((): EditorCore | T => {
		if (!selector) {
			return editor;
		}

		const next = selector(editor);
		if (
			snapshotCacheRef.current !== SNAPSHOT_UNSET &&
			isShallowEqual({
				a: snapshotCacheRef.current,
				b: next,
			})
		) {
			return snapshotCacheRef.current;
		}

		snapshotCacheRef.current = next;
		return next;
	}, [editor, selector]);

	return useSyncExternalStore(
		selector ? subscribeAll : subscribeNone,
		getSnapshot,
		getSnapshot,
	);
}

// ---------------------------------------------------------------------------
// Scoped hooks — subscribe to a single manager so unrelated manager changes
// do not trigger re-evaluation.  For example, usePlayback() components are
// immune to selection changes, and useSelection() components are immune to
// playback seeks.
//
// Factory: takes a function that extracts the subscribe() method from the
// editor, returns a hook with the same snapshot + equality-cache semantics as
// useEditor(selector).
// ---------------------------------------------------------------------------

type ManagerSubscribe = (onChange: () => void) => () => void;

function createScopedHook(getSubscribe: (editor: EditorCore) => ManagerSubscribe) {
	return function useScopedSelector<T>(selector: (editor: EditorCore) => T): T {
		const editor = useMemo(() => EditorCore.getInstance(), []);
		const cache = useRef<T | typeof SNAPSHOT_UNSET>(SNAPSHOT_UNSET);

		const subscribe = useCallback(
			(onChange: () => void) => getSubscribe(editor)(onChange),
			[editor],
		);

		const getSnapshot = useCallback((): T => {
			const next = selector(editor);
			if (
				cache.current !== SNAPSHOT_UNSET &&
				isShallowEqual({ a: cache.current, b: next })
			) {
				return cache.current as T;
			}
			cache.current = next;
			return next;
		}, [editor, selector]);

		return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
	};
}

/** Subscribes only to PlaybackManager — immune to timeline/selection/media changes. */
export const usePlayback = createScopedHook((e) => e.playback.subscribe.bind(e.playback));

/** Subscribes only to SelectionManager — immune to playback/timeline/media changes. */
export const useSelection = createScopedHook((e) => e.selection.subscribe.bind(e.selection));

/** Subscribes only to TimelineManager — immune to playback/selection/media changes. */
export const useTimeline = createScopedHook((e) => e.timeline.subscribe.bind(e.timeline));

/** Subscribes only to MediaManager — immune to playback/selection/timeline changes. */
export const useMedia = createScopedHook((e) => e.media.subscribe.bind(e.media));

/** Subscribes only to ProjectManager — immune to playback/timeline/media changes. */
export const useProject = createScopedHook((e) => e.project.subscribe.bind(e.project));

/** Subscribes only to ScenesManager — immune to playback/media/selection changes. */
export const useScenes = createScopedHook((e) => e.scenes.subscribe.bind(e.scenes));
