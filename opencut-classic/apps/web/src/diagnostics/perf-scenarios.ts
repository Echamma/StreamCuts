export type PerfScenarioId =
	| "small"
	| "medium"
	| "stress"
	| "migrated"
	| "offline-no-backend"
	| "gpu-degraded"
	| "low-storage";

export interface PerfBudget {
	readonly metric: string;
	readonly operator: "<=" | ">=" | "=";
	readonly value: number;
	readonly unit: string;
}

export interface PerfScenario {
	readonly id: PerfScenarioId;
	readonly label: string;
	readonly description: string;
	readonly budgets: readonly PerfBudget[];
}

export const PERF_SCENARIOS: readonly PerfScenario[] = [
	{
		id: "small",
		label: "Small",
		description: "1x 1080p H.264 clip plus audio.",
		budgets: [
			{
				metric: "scrub-stop-to-final-frame p95",
				operator: "<=",
				value: 50,
				unit: "ms",
			},
			{
				metric: "duplicate same-frame decode count",
				operator: "=",
				value: 0,
				unit: "count",
			},
		],
	},
	{
		id: "medium",
		label: "Medium",
		description: "8 visible visuals with text, blur background, masks, and audio.",
		budgets: [
			{ metric: "steady preview frame p95", operator: "<=", value: 33, unit: "ms" },
			{ metric: "resolve p95", operator: "<=", value: 4, unit: "ms" },
			{ metric: "frame descriptor p95", operator: "<=", value: 2, unit: "ms" },
			{ metric: "A/V drift", operator: "<=", value: 40, unit: "ms" },
			{ metric: "seek-resume resync", operator: "<=", value: 150, unit: "ms" },
		],
	},
	{
		id: "stress",
		label: "Stress",
		description: "100 tracks, 3,000 elements, 30 expanded clips.",
		budgets: [
			{
				metric: "scroll/zoom/select/drag main-thread p95",
				operator: "<=",
				value: 8,
				unit: "ms",
			},
			{
				metric: "React commits per animation frame",
				operator: "<=",
				value: 1,
				unit: "count",
			},
		],
	},
	{
		id: "migrated",
		label: "Migrated",
		description: "Project opened after storage/project migrations.",
		budgets: [],
	},
	{
		id: "offline-no-backend",
		label: "Offline",
		description: "Editor open and interactive without backend-derived assets.",
		budgets: [],
	},
	{
		id: "gpu-degraded",
		label: "GPU Degraded",
		description: "Reduced GPU capability or fallback compositor path.",
		budgets: [],
	},
	{
		id: "low-storage",
		label: "Low Storage",
		description: "Browser quota constrained and cache eviction active.",
		budgets: [],
	},
] as const;

export function findPerfScenario({
	id,
}: {
	id?: PerfScenarioId | null;
}): PerfScenario | null {
	if (!id) {
		return null;
	}

	return PERF_SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}
