# @xevion/tempo

Composable primitives and config-driven runners that replace scattered shell scripts with type-safe, structured tooling. Works with Bun, Node.js (22+), and Deno.

## Install

```bash
bun add -d @xevion/tempo    # or npm/pnpm/yarn
```

## Quick Start

Create a `tempo.config.ts` in your project root:

```ts
import { defineConfig, presets } from "@xevion/tempo";

export default defineConfig({
  subsystems: ["app", "api"],
  check: {
    commands: [
      presets.biome.check(),
      { label: "Type Check", command: "bunx tsc --noEmit" },
    ],
  },
  dev: {
    processes: [
      { label: "App", command: "bun run --hot src/index.ts" },
    ],
  },
});
```

Then run via the CLI:

```bash
tempo check        # parallel checks with spinner UI
tempo dev          # managed dev processes
tempo fmt          # sequential formatting
tempo lint         # sequential linting
tempo pre-commit   # staged-file formatter
tempo run <name>   # custom commands
```

## Architecture

Two layers:

- **Primitives** — low-level utilities (`ProcessGroup`, `run`, `runPiped`, `BackendWatcher`, etc.) exported via subpath imports for use in custom scripts
- **Runners** — config-driven orchestrators invoked through the `tempo` CLI that handle check, dev, fmt, lint, pre-commit, and custom command workflows

## Presets

Built-in presets for common toolchains:

| Preset | Toolchain |
|--------|-----------|
| `presets.biome` | Biome + SvelteKit |
| `presets.rust` | cargo check, clippy, test, fmt |
| `presets.go` | vet, staticcheck, test, gofumpt |
| `presets.gradle` | Gradle/Kotlin (detekt, test, ktlintFormat) |

## Subpath Exports

Import specific primitives without pulling in the full package:

```ts
import { ProcessGroup, run, runPiped } from "@xevion/tempo/proc";
import { newestMtime, ensureFresh } from "@xevion/tempo/preflight";
import { resolveTargets, isAll } from "@xevion/tempo/targets";
import { BackendWatcher } from "@xevion/tempo/watch";
import * as fmt from "@xevion/tempo/fmt";
import { createOctocovConfig } from "@xevion/tempo/octocov";
```

## Custom Commands

Define reusable commands with typed flags that work both via `tempo run` and direct execution:

```ts
import { defineCommand } from "@xevion/tempo";

export default defineCommand(
  {
    name: "seed",
    description: "Seed the database",
    flags: {
      count: { type: "number", default: 100, description: "Number of records" },
      reset: { type: "boolean", default: false, description: "Reset before seeding" },
    },
    run: async ({ flags, group, run }) => {
      if (flags.reset) await run(group, "bun run db:reset");
      await run(group, `bun run db:seed --count ${flags.count}`);
      return 0;
    },
  },
  import.meta.main,
);
```

## License

[LGPL-3.0-or-later](LICENSE)
