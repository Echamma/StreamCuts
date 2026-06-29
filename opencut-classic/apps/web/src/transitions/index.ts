import { defaultTransitions } from "./definitions";
import { transitionRegistry } from "./registry";

export * from "./registry";
export * from "./track-transitions";
export * from "./types";

let defaultsRegistered = false;

export function registerDefaultTransitions() {
	if (defaultsRegistered) {
		return;
	}

	for (const definition of defaultTransitions) {
		transitionRegistry.register(definition);
	}

	defaultsRegistered = true;
}
