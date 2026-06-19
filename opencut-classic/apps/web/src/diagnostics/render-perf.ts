import type { PerfScenarioId } from "./perf-scenarios";
import { findPerfScenario } from "./perf-scenarios";

/**
 * Lightweight rolling perf instrumentation for the render pipeline.
 *
 * Toggle at runtime from the devtools console:
 *   window.__renderPerf = true
 *   window.__renderPerfScenario = "medium"
 *
 * Every FLUSH_EVERY frames the aggregator dumps:
 *   - per-span timing summary (count / mean / p50 / p95 / max, in ms)
 *   - per-counter totals (uploads, manager notifications, cache hits, etc.)
 *   - sampler rows for heap/cache snapshots
 *
 * Zero overhead when disabled: `isRenderPerfEnabled()` short-circuits before
 * any recording happens, so call sites only pay for a global read.
 */

type SpanSample = number;

type SpanStats = {
	samples: SpanSample[];
};

type CounterStats = {
	total: number;
	frames: number;
};

type PerfSampler = () => Record<string, number | string>;

export type RenderPerfFrameReason =
	| "preview-idle"
	| "preview-edit"
	| "preview-playback"
	| "preview-scrub"
	| "snapshot"
	| "export";

export interface RenderPerfFrameMeta {
	reason: RenderPerfFrameReason;
	scenarioId?: PerfScenarioId;
	avDriftMs?: number;
	frameFreshnessMs?: number;
}

const FLUSH_EVERY = 60;

const spans = new Map<string, SpanStats>();
const counters = new Map<string, CounterStats>();
const pendingCountersThisFrame = new Map<string, number>();
const samplers = new Map<string, PerfSampler>();

let framesSinceFlush = 0;
let activeScenarioId: PerfScenarioId | null = null;

declare global {
	interface Window {
		__renderPerf?: boolean;
		__renderPerfScenario?: PerfScenarioId;
	}

	interface Performance {
		memory?: {
			usedJSHeapSize?: number;
			totalJSHeapSize?: number;
			jsHeapSizeLimit?: number;
		};
	}
}

export function isRenderPerfEnabled(): boolean {
	return typeof window !== "undefined" && window.__renderPerf === true;
}

export function recordSpan({
	name,
	durationMs,
}: {
	name: string;
	durationMs: number;
}): void {
	if (!isRenderPerfEnabled()) return;
	let stats = spans.get(name);
	if (!stats) {
		stats = { samples: [] };
		spans.set(name, stats);
	}
	stats.samples.push(durationMs);
}

export async function measureSpanAsync<T>({
	name,
	fn,
}: {
	name: string;
	fn: () => Promise<T>;
}): Promise<T> {
	if (!isRenderPerfEnabled()) return fn();
	const start = performance.now();
	try {
		return await fn();
	} finally {
		recordSpan({ name, durationMs: performance.now() - start });
	}
}

export function measureSpanSync<T>({
	name,
	fn,
}: {
	name: string;
	fn: () => T;
}): T {
	if (!isRenderPerfEnabled()) return fn();
	const start = performance.now();
	try {
		return fn();
	} finally {
		recordSpan({ name, durationMs: performance.now() - start });
	}
}

export function incrementCounter({
	name,
	by = 1,
}: {
	name: string;
	by?: number;
}): void {
	if (!isRenderPerfEnabled()) return;
	pendingCountersThisFrame.set(
		name,
		(pendingCountersThisFrame.get(name) ?? 0) + by,
	);
}

export function recordManagerNotification({
	manager,
}: {
	manager: string;
}): void {
	incrementCounter({ name: `notify:${manager}` });
}

export function recordReactCommit({
	scope,
	durationMs,
}: {
	scope: string;
	durationMs: number;
}): void {
	if (!isRenderPerfEnabled()) return;
	incrementCounter({ name: `react:${scope}:commits` });
	recordSpan({
		name: `react:${scope}:commit`,
		durationMs,
	});
}

export function registerRenderPerfSampler({
	name,
	sample,
}: {
	name: string;
	sample: PerfSampler;
}): () => void {
	samplers.set(name, sample);
	return () => {
		samplers.delete(name);
	};
}

/**
 * Pulls sub-span timings recorded inside the wasm `renderFrame` call and
 * feeds them into the aggregator as ordinary spans.
 */
export function recordWasmFrameProfile(
	entries: Array<{ name: string; durationMs: number }>,
): void {
	if (!isRenderPerfEnabled()) return;
	for (const entry of entries) {
		recordSpan({ name: entry.name, durationMs: entry.durationMs });
	}
}

/**
 * Called once per presented frame. Rolls pending-frame counters into the
 * aggregate and triggers a flush on cadence.
 */
export function onRenderPerfFrameComplete(meta?: RenderPerfFrameMeta): void {
	if (!isRenderPerfEnabled()) return;
	activeScenarioId =
		meta?.scenarioId ??
		(typeof window !== "undefined" ? window.__renderPerfScenario ?? null : null);

	if (meta) {
		incrementCounter({ name: `frameReason:${meta.reason}` });
		if (meta.frameFreshnessMs !== undefined) {
			recordSpan({
				name: "frameFreshness",
				durationMs: meta.frameFreshnessMs,
			});
		}
		if (meta.avDriftMs !== undefined) {
			recordSpan({
				name: "avDrift",
				durationMs: Math.abs(meta.avDriftMs),
			});
		}
	}

	for (const [name, count] of pendingCountersThisFrame) {
		let stats = counters.get(name);
		if (!stats) {
			stats = { total: 0, frames: 0 };
			counters.set(name, stats);
		}
		stats.total += count;
		stats.frames += 1;
	}
	pendingCountersThisFrame.clear();

	framesSinceFlush += 1;
	if (framesSinceFlush >= FLUSH_EVERY) {
		flush();
	}
}

function flush(): void {
	const spanRows: Array<Record<string, number | string>> = [];
	for (const [name, stats] of spans) {
		if (stats.samples.length === 0) continue;
		const sorted = [...stats.samples].sort((a, b) => a - b);
		const p = (q: number) =>
			sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
		const sum = sorted.reduce((acc, v) => acc + v, 0);
		spanRows.push({
			span: name,
			count: sorted.length,
			meanMs: +(sum / sorted.length).toFixed(2),
			p50Ms: +p(0.5).toFixed(2),
			p95Ms: +p(0.95).toFixed(2),
			maxMs: +sorted[sorted.length - 1].toFixed(2),
		});
	}
	spanRows.sort((a, b) => Number(b.meanMs) - Number(a.meanMs));

	const counterRows: Array<Record<string, number | string>> = [];
	for (const [name, stats] of counters) {
		counterRows.push({
			counter: name,
			perFrame: +(stats.total / Math.max(1, stats.frames)).toFixed(2),
			total: stats.total,
			frames: stats.frames,
		});
	}
	counterRows.sort((a, b) => Number(b.perFrame) - Number(a.perFrame));

	const heapUsedBytes = performance.memory?.usedJSHeapSize;
	const heapTotalBytes = performance.memory?.totalJSHeapSize;
	const heapLimitBytes = performance.memory?.jsHeapSizeLimit;

	const samplerRows = Array.from(samplers, ([samplerName, sample]) => {
		try {
			return {
				sampler: samplerName,
				...sample(),
			};
		} catch (error) {
			return {
				sampler: samplerName,
				error: error instanceof Error ? error.message : "Unknown sampler error",
			};
		}
	});

	if (heapUsedBytes !== undefined) {
		samplerRows.push({
			sampler: "heap",
			usedMb: +(heapUsedBytes / (1024 * 1024)).toFixed(1),
			totalMb:
				heapTotalBytes !== undefined
					? +(heapTotalBytes / (1024 * 1024)).toFixed(1)
					: "n/a",
			limitMb:
				heapLimitBytes !== undefined
					? +(heapLimitBytes / (1024 * 1024)).toFixed(1)
					: "n/a",
		});
	}

	const activeScenario = findPerfScenario({ id: activeScenarioId });
	const summaryLabel = activeScenario
		? `[render-perf] ${activeScenario.label} summary over ${framesSinceFlush} frames`
		: `[render-perf] summary over ${framesSinceFlush} frames`;

	console.groupCollapsed(summaryLabel);
	if (activeScenario) {
		console.log(activeScenario.description);
		if (activeScenario.budgets.length > 0) {
			console.table(
				activeScenario.budgets.map((budget) => ({
					metric: budget.metric,
					target: `${budget.operator} ${budget.value} ${budget.unit}`,
				})),
			);
		}
	}
	if (spanRows.length > 0) console.table(spanRows);
	if (counterRows.length > 0) console.table(counterRows);
	if (samplerRows.length > 0) console.table(samplerRows);
	console.groupEnd();

	spans.clear();
	counters.clear();
	framesSinceFlush = 0;
}
