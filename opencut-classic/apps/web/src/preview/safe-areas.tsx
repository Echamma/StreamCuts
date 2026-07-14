import {
	EMPTY_PREVIEW_OVERLAY_SOURCE_RESULT,
	type PreviewOverlayDefinition,
	type PreviewOverlaySourceResult,
} from "@/preview/overlays";

/** Toggleable title/action-safe guides drawn over the preview frame (EDIT-026).
 * Independent on/off overlay (like bookmark notes), surfaced as a checkbox in
 * the preview context menu. */
export const safeAreaPreviewOverlay: PreviewOverlayDefinition = {
	id: "safe-areas",
	label: "Show safe areas",
	defaultVisible: false,
};

// Classic broadcast margins: action-safe = inner 90% (5% inset), title-safe =
// inner 80% (10% inset). Expressed as percentages so the guides scale with the
// scene rect at any resolution or zoom.
const ACTION_SAFE_INSET = "5%";
const TITLE_SAFE_INSET = "10%";
const CENTER_MARK_LENGTH = 16;

function SafeAreaGuidesOverlay() {
	return (
		<div className="absolute inset-0">
			{/* Action-safe (90%) */}
			<div
				className="absolute border border-white/25"
				style={{ inset: ACTION_SAFE_INSET }}
			/>
			{/* Title-safe (80%) */}
			<div
				className="absolute border border-white/45"
				style={{ inset: TITLE_SAFE_INSET }}
			/>
			{/* Center cross */}
			<div
				className="absolute left-1/2 top-1/2 w-px -translate-x-1/2 -translate-y-1/2 bg-white/45"
				style={{ height: CENTER_MARK_LENGTH }}
			/>
			<div
				className="absolute left-1/2 top-1/2 h-px -translate-x-1/2 -translate-y-1/2 bg-white/45"
				style={{ width: CENTER_MARK_LENGTH }}
			/>
		</div>
	);
}

export function getSafeAreaPreviewOverlaySource({
	isVisible,
}: {
	isVisible: boolean;
}): PreviewOverlaySourceResult {
	if (!isVisible) {
		return {
			...EMPTY_PREVIEW_OVERLAY_SOURCE_RESULT,
			definitions: [safeAreaPreviewOverlay],
		};
	}

	return {
		definitions: [safeAreaPreviewOverlay],
		instances: [
			{
				id: safeAreaPreviewOverlay.id,
				mount: { kind: "scene" },
				plane: "under-interaction",
				pointerEvents: "none",
				render: () => <SafeAreaGuidesOverlay />,
			},
		],
	};
}
