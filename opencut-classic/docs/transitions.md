# Transitions

Transitions are registered from `apps/web/src/transitions/`.

## Built-ins

Built-in definitions live in `apps/web/src/transitions/definitions/` and are
registered by `registerDefaultTransitions()` in
`apps/web/src/transitions/index.ts`.

## Custom transition contract

Create a new definition that exports a `TransitionDefinition`:

```ts
import type { TransitionDefinition } from "@/transitions/types";

export const myTransition: TransitionDefinition = {
	type: "my-transition",
	name: "My Transition",
	description: "Describe the cut.",
	keywords: ["custom"],
	defaultDurationSeconds: 0.5,
	render: ({ context, from, to, width, height, progress }) => {
		context.clearRect(0, 0, width, height);
		context.globalAlpha = 1 - progress;
		context.drawImage(from, 0, 0, width, height);
		context.globalAlpha = progress;
		context.drawImage(to, 0, 0, width, height);
		context.globalAlpha = 1;
	},
};
```

Then register it:

```ts
import { transitionRegistry } from "@/transitions/registry";
import { myTransition } from "./definitions/my-transition";

transitionRegistry.register(myTransition);
```

The `render` function receives two fully rendered clip layers:

- `from`: outgoing clip canvas
- `to`: incoming clip canvas
- `progress`: `0` to `1`
- `params`: future-proof bag for custom controls

This keeps custom transitions isolated from timeline and renderer internals.
