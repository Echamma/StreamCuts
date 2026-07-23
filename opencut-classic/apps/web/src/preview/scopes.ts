import type {
	PreviewOverlayDefinition,
	PreviewOverlaySourceResult,
} from "./overlays";

/**
 * Scopes are a HUD-adjacent overlay: the toggle lives in the preview context
 * menu (via the overlay definition below), but the actual widgets render
 * directly inside `PreviewCanvas` — they need a ref to the wgpu output canvas
 * for the CPU-tap sampler, which the overlay render contract doesn't provide.
 */
export const scopesPreviewOverlay: PreviewOverlayDefinition = {
	id: "scopes",
	label: "Scopes",
	defaultVisible: false,
};

export function getScopesPreviewOverlaySource(): PreviewOverlaySourceResult {
	return {
		definitions: [scopesPreviewOverlay],
		instances: [],
	};
}
