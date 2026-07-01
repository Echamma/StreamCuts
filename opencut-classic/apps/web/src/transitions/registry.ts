import type { TransitionDefinition } from "./types";

class TransitionRegistry {
	private readonly definitions = new Map<string, TransitionDefinition>();

	register(definition: TransitionDefinition) {
		this.definitions.set(definition.type, definition);
	}

	get(type: string): TransitionDefinition | null {
		return this.definitions.get(type) ?? null;
	}

	list(): TransitionDefinition[] {
		return [...this.definitions.values()];
	}
}

export const transitionRegistry = new TransitionRegistry();
