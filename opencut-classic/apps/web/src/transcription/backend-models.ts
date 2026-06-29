/**
 * Faster-Whisper models the backend transcription worker can run. The `id` is
 * the model-size name passed straight to faster-whisper; the rest is UI metadata.
 * This list is the source of truth for the picker — the backend only reports
 * which of these ids are already downloaded.
 */
export interface BackendTranscriptionModel {
	id: string;
	label: string;
	description: string;
	approxSize: string;
}

export const BACKEND_TRANSCRIPTION_MODELS: BackendTranscriptionModel[] = [
	{
		id: "tiny",
		label: "Tiny",
		description: "Fastest, lowest accuracy",
		approxSize: "~75 MB",
	},
	{
		id: "base",
		label: "Base",
		description: "Fast, basic accuracy",
		approxSize: "~145 MB",
	},
	{
		id: "small",
		label: "Small",
		description: "Balanced speed and accuracy",
		approxSize: "~480 MB",
	},
	{
		id: "medium",
		label: "Medium",
		description: "High accuracy, slower",
		approxSize: "~1.5 GB",
	},
	{
		id: "large-v3",
		label: "Large v3",
		description: "Best accuracy, slowest",
		approxSize: "~3.1 GB",
	},
];

export const DEFAULT_BACKEND_TRANSCRIPTION_MODEL = "small";

export function getBackendModel(
	id: string,
): BackendTranscriptionModel | undefined {
	return BACKEND_TRANSCRIPTION_MODELS.find((model) => model.id === id);
}

export function isKnownBackendModel(id: string): boolean {
	return BACKEND_TRANSCRIPTION_MODELS.some((model) => model.id === id);
}
