import type { RenderPerfFrameReason } from "@/diagnostics/render-perf";

export type ScheduledFrameRequest = {
	time: number;
	reason: RenderPerfFrameReason;
};

/**
 * Event-driven preview frame scheduler.
 *
 * Instead of an unconditional requestAnimationFrame loop, consumers call
 * requestFrame() when something changes (playback tick, seek, render-tree
 * update).  The scheduler batches to the next animation frame, keeps only the
 * latest request (latest-wins), and ensures at most one render is in-flight.
 *
 * Usage:
 *   const scheduler = new PreviewRenderScheduler(({ time, reason }) => {
 *     return renderer.render({ node, time });
 *   });
 *   scheduler.requestFrame({ time, reason: "preview-playback" });
 *   // later:
 *   scheduler.dispose();
 */
export class PreviewRenderScheduler {
	private pending: ScheduledFrameRequest | null = null;
	private rendering = false;
	private rafId: number | null = null;
	private disposed = false;

	constructor(
		private readonly onRender: ({
			time,
			reason,
		}: {
			time: number;
			reason: RenderPerfFrameReason;
		}) => Promise<void>,
	) {}

	requestFrame({
		time,
		reason,
	}: {
		time: number;
		reason: RenderPerfFrameReason;
	}): void {
		if (this.disposed) return;
		// Latest request always supersedes pending ones.
		this.pending = { time, reason };
		if (!this.rendering && this.rafId === null) {
			this.rafId = requestAnimationFrame(() => {
				void this.flush();
			});
		}
	}

	getLastRequest(): ScheduledFrameRequest | null {
		return this.pending;
	}

	dispose(): void {
		this.disposed = true;
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
		this.pending = null;
	}

	private async flush(): Promise<void> {
		this.rafId = null;
		if (this.disposed || !this.pending || this.rendering) return;

		const frame = this.pending;
		this.pending = null;
		this.rendering = true;

		try {
			await this.onRender({ time: frame.time, reason: frame.reason });
		} catch (error) {
			console.warn("PreviewRenderScheduler: render error:", error);
		} finally {
			this.rendering = false;
			// If a new request arrived while we were rendering, schedule it.
			if (this.pending && !this.disposed && this.rafId === null) {
				this.rafId = requestAnimationFrame(() => {
					void this.flush();
				});
			}
		}
	}
}
