import { describe, expect, test } from "bun:test";
import {
	getSafeAreaPreviewOverlaySource,
	safeAreaPreviewOverlay,
} from "@/preview/safe-areas";

describe("safe-area preview overlay (EDIT-026)", () => {
	test("is an independent, off-by-default toggle", () => {
		expect(safeAreaPreviewOverlay.id).toBe("safe-areas");
		expect(safeAreaPreviewOverlay.defaultVisible).toBe(false);
	});

	test("hidden: exposes the toggle definition but draws nothing", () => {
		const source = getSafeAreaPreviewOverlaySource({ isVisible: false });
		expect(source.definitions).toEqual([safeAreaPreviewOverlay]);
		expect(source.instances).toHaveLength(0);
	});

	test("visible: mounts a single non-interactive scene overlay", () => {
		const source = getSafeAreaPreviewOverlaySource({ isVisible: true });
		expect(source.definitions).toEqual([safeAreaPreviewOverlay]);
		expect(source.instances).toHaveLength(1);

		const [instance] = source.instances;
		expect(instance.id).toBe("safe-areas");
		expect(instance.mount.kind).toBe("scene");
		expect(instance.plane).toBe("under-interaction");
		expect(instance.pointerEvents).toBe("none");
	});
});
