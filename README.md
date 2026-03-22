# @xevion/tempo

Consolidated developer scripts for Bun projects. Composable primitives and config-driven runners that replace scattered shell scripts with type-safe, structured tooling.

## Install

```bash
bun add -d @xevion/tempo
```

> **Bun only.** This package ships raw TypeScript and uses Bun APIs directly.

## Usage

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

Run via the CLI:

```bash
bunx tempo check        # parallel checks with spinner UI
bunx tempo dev          # managed dev processes
bunx tempo fmt          # sequential formatting
bunx tempo lint         # sequential linting
bunx tempo pre-commit   # staged-file formatter
bunx tempo run <name>   # custom commands
```

## Presets

Built-in presets for common toolchains:

- **`presets.biome`** — Biome + SvelteKit
- **`presets.rust`** — Rust (cargo check, clippy, test, fmt)
- **`presets.go`** — Go (vet, staticcheck, test, gofumpt)
- **`presets.gradle`** — Gradle/Kotlin (detekt, test, ktlintFormat)

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

Define reusable commands with typed flags:

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
