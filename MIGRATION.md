# Migrating a project to @xevion/tempo

Step-by-step guide for replacing ad-hoc scripts with tempo's config-driven runners.

---

## Prerequisites

- A supported runtime: **Bun**, **Node.js 22+** (with `--experimental-strip-types`), or **Deno**
- **tempo** available — either via `bun link` (development) or `bunx tempo` / `npx tempo` / global install (production)

## 1. Make tempo available

```bash
# Option A: link to local tempo source (development)
cd ~/projects/tempo && bun link

# Option B: install globally from npm (production, once published)
bun install -g @xevion/tempo
```

**No project-level `package.json` or `node_modules/` is needed.** Tempo's config loader automatically resolves `@xevion/tempo` imports in `tempo.config.ts` back to its own source, regardless of where the config file lives.

## 2. Audit existing scripts

Before writing the config, inventory what the project's scripts do. Typical patterns:

| Script pattern | Maps to |
|---|---|
| Parallel check runner (`check.ts`) | `tempo check` (check runner + config) |
| Dev server orchestrator (`dev.ts`) | `tempo dev` (dev runner + config) |
| Sequential formatter (`format.ts`) | `tempo fmt` (fmt runner) |
| Sequential linter (`lint.ts`) | `tempo lint` (lint runner) |
| Pre-commit hook | `tempo pre-commit` |
| Custom scripts | `tempo run <name>` (custom commands) |

For each script, note:
- **Commands** it runs (and which are conditional on tool availability)
- **Fix commands** (autoformat, autolint)
- **Preflights** (codegen, existence checks, tool detection)
- **Signal handling** (what happens on Ctrl+C)
- **Target filtering** (e.g., `--frontend-only`, `--backend-only` become `tempo dev frontend`)
- **CI behavior** (env injection, grouped output)

## 3. Identify subsystems

Group commands by logical subsystem. Common patterns:

- **Monorepo with frontend + backend**: two subsystems (`frontend`, `backend`)
- **Single-language project**: one subsystem per toolchain
- **Multi-service**: one subsystem per service

Each subsystem gets:
- A name (used in `tempo check backend`, `tempo dev frontend`)
- Aliases for convenience (`fe`, `be`, `web`, `go`, `rs`)
- Optional `cwd` if the subsystem lives in a subdirectory
- Optional `requires` for tool dependencies

## 4. Create `tempo.config.ts`

Start with the minimal config and expand:

```ts
import { defineConfig } from "@xevion/tempo";

export default defineConfig({
  subsystems: {
    frontend: {
      aliases: ["front", "web", "fe"],
      cwd: "web",
      commands: {
        "format-check": "bunx biome check .",
        "format-apply": "bunx biome check --write .",
        lint: "bun run lint",
        "type-check": "bun run check",
        build: "bun run build",
      },
      autoFix: {
        "format-check": "format-apply",
      },
    },
    backend: {
      aliases: ["back", "go", "be"],
      requires: ["go"],
      commands: {
        "format-check": {
          cmd: 'test -z "$(goimports -l .)"',
          requires: ["goimports"],
          hint: "Run `goimports -w .` to fix formatting",
        },
        "format-apply": {
          cmd: "goimports -w .",
          requires: ["goimports"],
        },
        lint: {
          cmd: "golangci-lint run --timeout=5m",
          requires: ["golangci-lint"],
        },
        build: "go build -o /dev/null .",
        test: "go test -race -count=1 ./...",
      },
      autoFix: {
        "format-check": "format-apply",
      },
    },
  },
});
```

### Command formats

- **String**: runs via `sh -c` — shell features (pipes, redirects, builtins, quoting) all work
- **Array**: exec'd directly — no shell interpretation, best for commands with complex args
- **Object**: full control — `cmd` (string or array), plus `env`, `cwd`, `hint`, `requires`, `warnIfExitCode`, `timeout`

### Using presets

For standard toolchains, use built-in presets instead of manually listing commands:

```ts
import { defineConfig, presets } from "@xevion/tempo";

export default defineConfig({
  subsystems: {
    rust: presets.rust({ allFeatures: true }),
    web: presets.biome({ svelte: true, vitest: true }),
  },
});
```

Available presets: `rust`, `biome`, `go`, `gradle`.

## 5. Configure the check runner

```ts
check: {
  autoFixStrategy: "fix-first",  // or "fix-on-fail"
  exclude: [
    // Don't run fix commands as checks
    "frontend:format-apply",
    "backend:format-apply",
  ],
  options: {
    "backend:format-check": {
      hint: "Run `tempo fmt backend` to fix formatting",
    },
    "backend:test": {
      warnIfExitCode: 2,  // treat exit 2 as warning, not failure
    },
  },
},
```

**Key decisions**:
- `fix-first`: runs fix commands before checks (faster feedback on `--fix`)
- `fix-on-fail`: runs checks first, fixes only failures, re-verifies (safer)
- `exclude`: remove fix/apply commands from the check list (they're not checks)

## 6. Migrate preflights

Preflights run before checks. Two forms:

### Declarative (file freshness)
```ts
preflights: [
  {
    label: "panda codegen",
    sources: { dir: "web/src", pattern: "**/*.{svelte,ts}" },
    artifacts: { dir: "web/styled-system", pattern: "**/*.{js,mjs,d.ts}" },
    regenerate: "bun run --cwd web codegen",
    reason: "svelte-check depends on styled-system types",
  },
],
```

### Functional (with context)

Functional preflights receive a context with `logger` and `fail()` for structured error handling:

```ts
preflights: [
  (ctx) => {
    if (!existsSync("web/node_modules")) {
      ctx.fail("web/node_modules not found -- run `bun install` first");
    }
  },
],
```

`ctx.fail(message)` logs the error and aborts the runner. Use `ctx.logger.warn(message)` for non-fatal warnings.

## 7. Migrate hooks

Hooks run at lifecycle points. The hook context provides structured logging and abort:

```ts
hooks: {
  "before:check": async (ctx) => {
    // Structured logging
    ctx.logger.info("setting up coverage...");
    ctx.logger.warn("octocov not found, skipping coverage");

    // Abort with a clear error message
    if (!existsSync(".env")) {
      ctx.fail(".env not found -- copy .env.example first");
    }

    // Inject env vars
    ctx.env.MY_VAR = "value";

    // Register cleanup
    ctx.addCleanup(() => fs.unlinkSync(tempFile));

    // Dynamically modify commands
    const sub = ctx.config.subsystems.backend;
    if (sub?.commands) {
      sub.commands.test = {
        cmd: ["go", "test", "-coverprofile=cov.out", "./..."],
        warnIfExitCode: 2,
      };
    }
  },
  "before:dev": (ctx) => {
    if (ctx.targets.has("backend") && !existsSync(".env")) {
      ctx.fail(".env not found -- copy .env.example first");
    }
  },
},
```

**Do not use `process.exit()` or bare `console.error()` in hooks.** Use `ctx.fail()` to abort and `ctx.logger` for output — these integrate with tempo's error handling and produce consistent formatting.

Available hooks: `before:check`, `after:check`, `before:check:each`, `after:check:each`, `before:dev`, `after:dev`.

## 8. Octocov integration

For Go projects using octocov for coverage reporting, use the built-in integration:

```ts
import { createOctocovConfig, testablePackages } from "@xevion/tempo/octocov";
import { hasTool } from "@xevion/tempo/proc";

hooks: {
  "before:check": async (ctx) => {
    if (!hasTool("octocov")) return;

    const octocovConfig = createOctocovConfig("Owner/repo");
    ctx.addCleanup(octocovConfig.cleanup);
    Object.assign(ctx.env, octocovConfig.env);

    const pkgs = testablePackages();
    const sub = ctx.config.subsystems.backend;
    if (sub?.commands) {
      sub.commands.test = {
        cmd: [
          "bash", "-c",
          `go test -coverprofile=coverage.out ${pkgs.join(" ")} && octocov --config=${octocovConfig.configPath} --report coverage.out`,
        ],
        warnIfExitCode: 2,
        hint: "Coverage below threshold -- run `just cov` for details.",
      };
    }
  },
},
```

`createOctocovConfig(repo)` patches `.octocov.yml` to use `local://` datastores and returns a config path, env vars, and cleanup function. `testablePackages()` returns Go packages with test files (avoids 0%-coverage noise).

## 9. Configure the dev runner

```ts
dev: {
  exitBehavior: "first-exits",  // or "all-exit"
  processes: {
    frontend: {
      type: "unmanaged",
      cmd: ["bun", "run", "dev"],
      cwd: "web",
    },
    backend: {
      type: "unmanaged",
      cmd: ["air", "-build.send_interrupt", "true"],
      env: { PORT: "3001" },
    },
  },
},
```

**Process types**:
- `unmanaged`: spawned and left running (Vite, Air, etc.)
- `managed`: build-watch-restart cycle via `BackendWatcher` (custom Go builds, etc.)

**Target filtering**: `tempo dev frontend` runs only the frontend process. No custom flags needed — targets are first-class.

## 10. Migrate custom commands

Register scripts that don't fit the runner model:

```ts
custom: {
  cov: "./scripts/octocov-local.ts",
  deploy: "./scripts/deploy.ts",
},
```

For new scripts, use `defineCommand` for type-safe flags:

```ts
import { defineCommand } from "@xevion/tempo";

export default defineCommand({
  name: "deploy",
  description: "Deploy to production",
  flags: {
    dry: { type: Boolean, description: "Dry run" },
  },
  run({ flags, run }) {
    if (!flags.dry) run("kubectl apply -f k8s/");
    return 0;
  },
}, import.meta.main);  // enables `bun scripts/deploy.ts` directly
```

## 11. Update the Justfile

Replace script invocations with tempo:

```just
check *flags:
    bunx tempo check {{flags}}

dev *flags:
    -bunx tempo dev {{flags}}

format *flags:
    bunx tempo fmt {{flags}}

lint *flags:
    bunx tempo lint {{flags}}

cov:
    bunx tempo run cov
```

Keep non-tempo recipes as-is (`build`, `generate`, `db`, `docker-*`, `clean`).

## 12. Verify

Run through each command and compare output to the old scripts:

```bash
bunx tempo check          # all subsystems
bunx tempo check frontend # single subsystem
bunx tempo check --fix    # with auto-fix
bunx tempo fmt            # format
bunx tempo lint           # lint
bunx tempo run --list     # custom commands
```

## 13. Clean up

Once verified:
- Remove old `scripts/lib/` (fmt.ts, proc.ts) — these are now in tempo
- Remove any root `package.json` that only existed for the tempo dependency
- Keep project-specific scripts referenced by `custom:` or hooks
- Commit `tempo.config.ts`

---

## Gotchas

### String commands run via `sh -c`
String commands are shell commands — pipes, redirects, quoted args, and builtins all work. Array commands are exec'd directly (no shell). Use arrays when you need precise argument control.

### `tempo run` flags need `--` separator
`tempo run greet --name Xevion` won't work — cleye consumes `--name` as an unknown flag. Use `tempo run greet -- --name Xevion`.

### format-apply commands appear as checks
By default, every command in a subsystem runs during `tempo check`. Exclude fix/apply commands:

```ts
check: {
  exclude: ["frontend:format-apply", "backend:format-apply"],
},
```

### No project-level dependency needed
Tempo automatically resolves its own imports when loading `tempo.config.ts`. You do not need a `package.json`, `node_modules/`, or `bun link` in the target project. Just ensure tempo is available on PATH (via `bun link` during development or global install in production).

### Presets vs custom commands
Presets (`presets.rust()`, `presets.go()`, etc.) provide standard commands for common toolchains. If your project has non-standard commands, use a custom subsystem config instead — or spread the preset and override specific commands.

### CI detection
Tempo auto-detects CI via `CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, etc. In CI mode:
- `ci.inject` env vars are added to all commands (default: `CI=1`)
- `ci.groupedOutput` wraps output in `::group::` for GitHub Actions
- TUI spinner is disabled

### Target filtering replaces custom flags
Don't define `--frontend-only` / `--backend-only` dev flags. Use `tempo dev frontend` / `tempo dev backend` instead — target filtering is built-in.
