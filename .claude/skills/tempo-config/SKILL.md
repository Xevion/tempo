---
name: tempo-config
description: Comprehensive guide for writing, configuring, and improving @xevion/tempo configs in consumer projects. Auto-activate when creating or editing tempo.config.ts files, adding presets, defining subsystems, writing custom commands, or setting up dev/check runners.
user-invocable: true
argument-hint: "[question or task]"
---

# @xevion/tempo Configuration Guide

Use this skill when writing or modifying `tempo.config.ts` in any project that consumes `@xevion/tempo`. This covers the full config API, all presets, custom commands, hooks, preflights, and best practices.

## Installation

```bash
# In consumer projects
bun add -d @xevion/tempo
# or
npm install -D @xevion/tempo
```

The package provides a `tempo` CLI binary and TypeScript API. It works with Bun, Node.js 22+, and Deno.

## Config File

Config lives in `tempo.config.ts` at the project root. The CLI auto-discovers it by walking up from `cwd`. Override with `--config <path>`.

```typescript
import { defineConfig, presets } from "@xevion/tempo";

export default defineConfig({
  subsystems: { /* required, at least one */ },
  preflights: [ /* optional */ ],
  check: { /* optional */ },
  dev: { /* optional */ },
  custom: { /* optional */ },
  ci: { /* optional */ },
  hooks: { /* optional */ },
});
```

`defineConfig()` provides full type inference — subsystem names flow as a union type into all dependent fields (hooks, check options, dev processes, etc.).

## Subsystems

Subsystems are the top-level organizational unit. Each represents a project component (frontend, backend, infra, etc.).

```typescript
subsystems: {
  frontend: {
    aliases: ["f", "front", "web"],  // short names for CLI targeting
    cwd: "web",                       // working directory (relative to project root)
    alwaysRun: false,                 // if true, always included in tempo check
    requires: ["bun"],                // tools that must be on PATH
    commands: {
      // String shorthand — split on whitespace
      "format-check": "bunx biome check .",
      // Array — no splitting, passed directly to spawn
      "format-apply": ["bunx", "biome", "check", "--write", "."],
      // Object — full options
      lint: {
        cmd: "bunx biome lint .",
        env: { NODE_ENV: "production" },
        cwd: "web",                    // override subsystem cwd
        hint: "Run `tempo fmt frontend` to auto-fix",
        warnIfExitCode: 2,             // treat as warning, not failure
        timeout: 120,                  // kill after N seconds
        requires: ["biome"],           // per-command tool requirements
      },
    },
    autoFix: {
      // Maps check command → fix command (both must exist in commands)
      "format-check": "format-apply",
    },
  },
}
```

**Key behaviors:**
- `aliases` enable short CLI targeting: `tempo check f` = `tempo check frontend`
- `cwd` is inherited by all commands unless overridden per-command
- `alwaysRun: true` subsystems run even when other targets are specified (use for security audits, etc.)
- `requires` checks tool availability before running; skips with a warning if missing
- Command `env` is merged on top of `process.env`, not replacing it

## Presets

Factory functions that return `SubsystemConfig` objects. Spread into subsystem definitions and override as needed.

### `presets.rust(options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `manifestPath` | `string` | — | Path to `Cargo.toml` |
| `features` | `string[]` | — | Feature flags |
| `allFeatures` | `boolean` | — | Use `--all-features` |
| `testFilter` | `string` | — | nextest filter expression |
| `bin` | `string` | — | Binary name for build |

Provides: `format-check`, `format-apply`, `lint`, `test`, `build` commands with `cargo fmt`, `clippy`, `nextest`, and `cargo build`.

```typescript
backend: {
  ...presets.rust({ testFilter: "not test(export_bindings)", bin: "server" }),
  aliases: ["b", "back"],
  cwd: "backend",
},
```

### `presets.biome(options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `svelte` | `boolean` | `false` | Add `svelte-check` type-check command |
| `vitest` | `boolean` | `svelte` | Add `vitest run` test command |
| `cwd` | `string` | — | Working directory |

Provides: `format-check`, `format-apply`, `lint`, `build`, and optionally `type-check` and `test`.

```typescript
frontend: {
  ...presets.biome({ svelte: true }),
  aliases: ["f", "front"],
  cwd: "web",
},
```

### `presets.go(options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cwd` | `string` | — | Working directory |
| `race` | `boolean` | `true` | Add `-race` to tests |
| `timeout` | `string` | `"5m"` | Lint timeout |
| `buildTarget` | `string` | `"./cmd/server"` | Build target |

Provides: `format-check`, `format-apply`, `lint`, `build`, `test` with `goimports`, `golangci-lint`, `go build/test`.

### `presets.gradle(options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cwd` | `string` | — | Gradle project directory |
| `quiet` | `boolean` | `true` | Add `--quiet` |
| `configurationCache` | `boolean` | `true` | Enable `--configuration-cache` |
| `subprojects` | `string[]` | — | Subproject targets for compile |

Provides: `format-check`, `format-apply`, `lint`, `compile`, `test` with Spotless, ktlint, Detekt, Gradle.

### Combining presets with overrides

Presets return plain objects — spread them and override any field:

```typescript
backend: {
  ...presets.rust(),
  aliases: ["b"],           // override preset aliases
  commands: {
    ...presets.rust().commands,
    test: "cargo test",     // override specific command
    "custom-check": "my-tool check",  // add extra command
  },
},
```

## Check Runner

```typescript
check: {
  exclude: ["frontend:build"],        // skip specific subsystem:action pairs
  autoFixStrategy: "fix-first",       // "fix-first" (default) | "fix-on-fail"
  options: {
    "backend:test": {
      env: { DATABASE_URL: "postgresql://localhost/dev" },
      hint: "Start the database: just db start",
      warnIfExitCode: 2,
      timeout: 120,
    },
  },
  renderer: undefined,                // custom renderer function (escape hatch)
},
```

**Auto-fix strategies:**
- `"fix-first"` (default): Run all fixers serially, then run all checks in parallel. Simpler.
- `"fix-on-fail"`: Run all checks in parallel first, fix only failures, re-verify fixed checks. More efficient when most checks pass.

**Check matrix:** All commands across all subsystems are included by default. Use `exclude` to remove specific pairs. Adding a command to a subsystem automatically includes it in `tempo check`.

Config-defined flags can be added to check via `check.flags`:
```typescript
check: {
  flags: {
    strict: { type: Boolean, description: "Enable strict mode" },
  },
  // ... other check config
}
```

CLI: `tempo check [targets...] [--fix] [--strict]`

## Dev Runner

```typescript
dev: {
  flags: {
    embed: { type: Boolean, alias: "e", description: "Embed frontend" },
    verbose: { type: Boolean, alias: "v", description: "Verbose output" },
  },
  exitBehavior: "first-exits",  // "first-exits" (default) | "all-exit"
  processes: {
    frontend: {
      type: "unmanaged",       // spawn and let it manage itself
      cmd: "bun run dev",
    },
    backend: {
      type: "managed",         // tempo manages file watching + rebuild cycle
      watch: {
        dirs: ["src"],
        exts: [".rs"],
        extraPaths: ["Cargo.toml", "Cargo.lock"],
        debounce: 200,
      },
      build: { cmd: "cargo build --bin server", verbose: false },
      run: { cmd: "./target/debug/server", passthrough: true },
      interrupt: true,         // kill current build on new changes
    },
  },
},
```

**Process types:**
- `"unmanaged"`: Just spawns the command. Use for tools with built-in watch (Vite, Air, nodemon).
- `"managed"`: Tempo manages full lifecycle via BackendWatcher (5-state machine: building -> idle -> running -> building_with_server -> swapping). Use for compiled backends.

CLI: `tempo dev [targets...] [--flags...]`

## Preflights

Run before checks to detect and regenerate stale artifacts.

```typescript
preflights: [
  // Declarative — tempo handles mtime comparison
  {
    label: "bindings",
    sources: { dir: "src", pattern: "**/*.rs" },
    artifacts: { dir: "web/src/lib/bindings", pattern: "*.ts" },
    regenerate: "cargo test --lib export_bindings",
    reason: "Rust sources changed",
  },
  // Function escape hatch
  async (ctx) => {
    // ctx.logger.info/warn/error
    // ctx.fail("message") — abort with error
    // Import primitives: newestMtime, ensureFresh from "@xevion/tempo/preflight"
  },
],
```

Preflights run serially. A failure stops the check run immediately.

## Custom Commands

Custom commands are registered as top-level CLI subcommands. Invoke directly (`tempo smoke`) or via the `run` alias (`tempo run smoke`). Custom commands can shadow built-in commands.

```typescript
custom: {
  smoke: "./scripts/smoke.ts",           // file path (default export must be defineCommand result)
  "db-reset": "./scripts/db-reset.ts",

  // Inline function — no flags, receives CommandContext
  seed: async (ctx) => {
    ctx.run("bun run seed");
    return 0;
  },

  // Inline spec — with flags and description
  deploy: {
    description: "Deploy to production",
    flags: {
      dry: { type: Boolean, alias: "d", description: "Dry run" },
      env: { type: String, default: "staging", description: "Target environment" },
    },
    run: async (ctx) => {
      if (ctx.flags.dry) {
        ctx.fmt.theme.info("Dry run mode");
      }
      ctx.run(`deploy --env ${ctx.flags.env}`);
      return 0;
    },
  },
},
```

### defineCommand (for file-based custom commands)

```typescript
// scripts/smoke.ts
import { defineCommand } from "@xevion/tempo";

export default defineCommand({
  name: "smoke",
  description: "Run smoke tests against the staging API",
  flags: {
    url: { type: String, default: "http://localhost:3000", description: "Base URL" },
    verbose: { type: Boolean, alias: "v", description: "Verbose output" },
  },
  run: async (ctx) => {
    // ctx.group — ProcessGroup for managed spawning
    // ctx.config — resolved TempoConfig (null if run standalone)
    // ctx.flags — typed flags { url: string, verbose: boolean }
    // ctx.args — positional arguments after flags
    // ctx.run() — synchronous execution (inherited stdio)
    // ctx.runPiped() — synchronous piped execution
    // ctx.fmt — formatting utilities (colors, theme, etc.)

    ctx.run(`curl -sf ${ctx.flags.url}/health`);
    return 0;
  },
}, import.meta.main);  // second arg enables standalone execution: bun scripts/smoke.ts
```

## Lifecycle Hooks

```typescript
hooks: {
  "before:check": async (ctx) => {
    // ctx.config, ctx.flags, ctx.targets, ctx.env, ctx.logger, ctx.addCleanup, ctx.fail
  },
  "after:check": async (ctx, results) => {
    // results: Map<string, CollectResult> — keyed by "subsystem:action"
  },
  "before:check:each": async (ctx, check) => {
    // check: { name, subsystem, action, cmd }
  },
  "after:check:each": async (ctx, check, result) => {
    // result: { name, stdout, stderr, exitCode, elapsed }
  },
  "before:dev": async (ctx) => { /* validate env, start docker, etc. */ },
  "after:dev": async (ctx) => { /* cleanup */ },
},
```

- `before:*` hooks that throw abort the runner
- `after:*` hooks run even on failure (for cleanup)
- `ctx.targets` is typed as `Set<"frontend" | "backend" | ...>` (not `Set<string>`)

## CI Configuration

```typescript
ci: {
  enabled: undefined,           // auto-detect from CI env vars (default)
  inject: { CI: "1" },         // env vars added to all subprocesses in CI
  groupedOutput: true,          // ::group:: annotations for GitHub Actions
},
```

Auto-detects: `CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `JENKINS_URL`, `BUILDKITE`.

## CLI Reference

| Command | Description |
|---------|-------------|
| `tempo check [targets...] [--fix] [flags...]` | Parallel checks with spinner, auto-fix, preflights |
| `tempo dev [targets...] [flags...]` | Multi-process dev server manager |
| `tempo fmt [targets...] [flags...] [-- passthrough...]` | Sequential formatting |
| `tempo lint [targets...] [flags...] [-- passthrough...]` | Sequential linting |
| `tempo pre-commit [flags...]` | Staged-file formatter with partial staging detection |
| `tempo <custom-name> [args...]` | Custom command (top-level subcommand) |
| `tempo run <name> [args...]` | Custom command (via run alias) |
| `tempo run --list` | List registered custom commands |

Global flags (pre-extracted, work with all commands): `--config <path>`, `-v`/`-vv`/`-vvv`, `-q`/`--quiet`, `--log-file <path>`, `--help`, `--version`

All runner commands accept config-defined flags from their respective config sections (e.g., `check.flags`, `dev.flags`).

Target resolution: positional args resolve via alias map. No targets = all subsystems.

## Primitives (Layer 1)

For advanced use cases, import primitives directly:

| Import | Provides |
|--------|----------|
| `@xevion/tempo/proc` | `ProcessGroup`, `run`, `runPiped`, `spawnCollect`, `raceInOrder` |
| `@xevion/tempo/fmt` | Theme colors (ansis/catppuccin), `formatDuration`, `formatTokens`, `termWidth`, `wordWrap`, `parseArgs`, TTY detection |
| `@xevion/tempo/preflight` | `newestMtime`, `ensureFresh` |
| `@xevion/tempo/targets` | `resolveTargets`, `isAll`, `targetLabel` |
| `@xevion/tempo/watch` | `BackendWatcher` (5-state machine) |
| `@xevion/tempo/octocov` | `createOctocovConfig`, `testablePackages` |

## Common Patterns

### Multi-language monorepo

```typescript
export default defineConfig({
  subsystems: {
    frontend: { ...presets.biome({ svelte: true, vitest: true }), cwd: "web", aliases: ["f"] },
    backend: { ...presets.rust({ bin: "server" }), aliases: ["b"] },
    infra: { ...presets.go({ buildTarget: "./cmd/migrate" }), cwd: "infra", aliases: ["i"] },
    security: {
      alwaysRun: true,
      aliases: ["sec"],
      commands: { audit: "bun audit --audit-level=moderate" },
    },
  },
  check: {
    exclude: ["frontend:build"],  // don't build frontend during checks
    autoFixStrategy: "fix-first",
  },
});
```

### Minimal single-subsystem

```typescript
export default defineConfig({
  subsystems: {
    app: {
      aliases: ["a"],
      commands: {
        "format-check": "prettier --check .",
        "format-apply": "prettier --write .",
        lint: "eslint .",
        test: "vitest run",
        build: "vite build",
      },
      autoFix: { "format-check": "format-apply" },
    },
  },
});
```

### Adding custom checks alongside presets

```typescript
backend: {
  ...presets.rust(),
  commands: {
    ...presets.rust().commands,
    "sql-check": { cmd: "cargo sqlx prepare --check", hint: "Run: cargo sqlx prepare" },
    "schema-check": "./scripts/check-schema.sh",
  },
},
```

## Type Requirements

- TypeScript 5.0+ for `const` type parameters in `defineConfig`
- TypeScript 5.4+ for `NoInfer` (autoFix type validation)
- Fallback for older TS: `as const satisfies TempoConfig`

## Best Practices

1. **Use presets as a starting point** — spread and override rather than writing commands from scratch
2. **Keep aliases short** — single letters for frequently targeted subsystems
3. **Use `alwaysRun`** for cross-cutting concerns (security audits, license checks)
4. **Prefer `fix-first` strategy** unless your checks are expensive and rarely fail
5. **Use `requires`** to gracefully skip checks when tools aren't installed
6. **Use `hint`** on commands that often fail for environmental reasons (missing DB, etc.)
7. **Use preflights** for codegen/bindings rather than manual regeneration
8. **Keep custom commands in separate files** with `defineCommand` for complex logic; use inline functions/specs for simple ones
9. **Use `warnIfExitCode`** for checks that should surface issues without blocking the pipeline
