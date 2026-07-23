import { effectsRegistry } from "../registry";
import { blurEffectDefinition } from "./blur";
import { colorWheelsEffectDefinition } from "./color-wheels";

const defaultEffects = [blurEffectDefinition, colorWheelsEffectDefinition];

export function registerDefaultEffects(): void {
	for (const definition of defaultEffects) {
		if (effectsRegistry.has(definition.type)) {
			continue;
		}
		effectsRegistry.register({
			key: definition.type,
			definition,
		});
	}
}
