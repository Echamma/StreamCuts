# opencut-wasm

Shared video editor logic compiled to WebAssembly for the StreamCuts web app.

## Package

The web workspace installs the checked-in `rust/wasm/pkg` build through a local
`file:` dependency. This keeps the Rust source, browser bindings, and deployed
web app on the same version without access to the upstream npm package.

## Usage

```ts
import { formatTimecode, mediaTimeFromSeconds } from "opencut-wasm";

const ticks = mediaTimeFromSeconds(1.5);
const label = formatTimecode({ ticks });
```

All exports are documented in the [TypeScript definitions](./pkg/opencut_wasm.d.ts).

## Source

Functions are implemented in Rust under [`rust/crates/`](../crates/). The
generated files in `pkg` are build output; do not edit them directly.

## Local development

After changing the Rust source, rebuild the package from the workspace root and
commit the changed files in `rust/wasm/pkg` with the source change:

```bash
# From the repo root
bun run build:wasm
```

`wasm-pack` writes `pkg/.gitignore` with `*`; use `git add -f
rust/wasm/pkg/<generated-file>` for any newly generated files.

While you work, rebuild on changes from the repo root:

```bash
bun dev:wasm
```
