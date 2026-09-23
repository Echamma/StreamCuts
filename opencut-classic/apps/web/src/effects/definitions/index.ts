import { effectsRegistry } from "../registry";
import { blurEffectDefinition } from "./blur";
import { colorWheelsEffectDefinition } from "./color-wheels";
import { lutEffectDefinition } from "./lut";
import { curvesEffectDefinition } from "./curves";

const defaultEffects = [
	blurEffectDefinition,
	colorWheelsEffectDefinition,
	lutEffectDefinition,
	curvesEffectDefinition,
];

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
