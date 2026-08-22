---
name: tempo-config
description: Guide for writing and improving @xevion/tempo configs in consumer projects. Auto-activate when creating or editing tempo.config.ts, adding presets, declaring tasks, wiring dev sessions, or writing custom commands.
user-invocable: true
argument-hint: "[question or task]"
---

# @xevion/tempo Configuration Guide

Use this when writing or modifying `tempo.config.ts`. It covers the task model, presets,
caching, dev sessions, and the conventions worth following.

## Install

```bash
bun add -d @xevion/tempo    # or npm/pnpm/yarn
```

A globally installed tempo also works in a project with no `package.json`: the CLI registers
itself as a virtual module. Types still need the devDependency, since the compiler cannot see
a module that only exists at runtime.

## The model

Three ideas, and everything else follows from them.

**A task is the atom.** A name, a body, tags, requirements, and edges. Nothing else registers
work.

**A command is a selector, not a runner.** `check` means "everything tagged `check`". Adding a
task to a tag adds it to the command; there is no second place to list it.

**A body is a shell string, an argv array, or a TypeScript function, and all three are peers.**
A function body gets the same row, timing, cancellation, and JSON record as a spawned process.
Reaching for a function is not an escape hatch.

```ts
import { defineConfig, presets, task } from "@xevion/tempo";

export default defineConfig({
  tasks: [
    task({ name: "web:types", body: "bunx tsc --noEmit", tags: ["check"] }),
  ],
  commands: {
    check: { description: "Run every check in parallel", tags: ["check"] },
  },
});
```

## `task(...)`

| Field | Meaning |
|---|---|
| `name` | `namespace:short`. The namespace is what `tempo check web` narrows on. |
| `body` | Shell string, argv array, or `(ctx) => number \| void`. |
| `tags` | What commands select on. |
| `needs` | Must succeed first, and is **pulled into the run**. |
| `after` | Ordering only, **inert unless the target is already selected**. |
| `requires` | `{ tool }`, `{ env }`, `{ file }`, each with an optional `hint`. |
| `cwd` | Resolved against the project root, never the invocation directory. |
| `env` | Extra environment for this task. |
| `inputs` / `outputs` | Globs that make the task cacheable. |
| `persistent` | Long-lived. Never a valid `needs` target for a one-shot task. |
| `watch` | `{ paths, exts?, interrupt?, debounce? }`. Persistent tasks only. |
| `readyWhen` | Gates dependents on serving rather than on spawning. |
| `passthrough` | Append the run's arguments to this task. |
| `lock` | `true`, or a path, to serialize against other tempo processes. |
| `always` | Stay in the run even when positional targets narrow it. |

### `needs` vs `after`

The distinction is the one most task runners get wrong, so use it deliberately.

```ts
// Pulls gen:bindings into the run and fails if it fails.
task({ name: "web:type-check", body: "bun run check", needs: ["gen:bindings"] })

// Runs after mod:verify when mod:verify was already selected, and never pulls it in.
// Use this for a reporting step that must still run when the thing it reports on failed.
task({ name: "mod:report", body: "...", tags: ["check"], after: ["mod:verify"] })
```

A skipped task closes its gate, so anything that `needs` it is reported as **blocked** rather
than silently passing. That is usually what you want; when it is not, `after` is the tool.

## Requirements

Declare what the environment must provide rather than probing for it in a body. Missing
requirements **skip** the task locally and **fail** it under CI, so a machine without a tool
loses a check visibly instead of pretending.

```ts
task({
  name: "backend:sqlc-diff",
  body: "sqlc diff",
  tags: ["check"],
  requires: [{ tool: "sqlc", hint: "run `tempo generate` to regenerate sqlc code" }],
})
```

A `file` requirement is the idiomatic way to express "this package was never installed":

```ts
const WEB_DEPS = { file: "web/node_modules", hint: "run `bun install` inside web/ first" };
```

## Caching replaces preflights

There is no preflight system. A generator is an ordinary task that declares what it reads and
writes, and the engine skips it while its inputs are unchanged. Fingerprints are content
hashes, not timestamps.

```ts
task({
  name: "gen:tygo",
  body: "tygo generate",
  tags: ["check", "generate"],
  requires: [{ tool: "tygo" }],
  inputs: ["internal/server/types.go"],
  outputs: ["web/src/lib/types.gen.ts"],
})
```

A cache hit satisfies dependents, so anything that `needs` it proceeds immediately. Everything
tempo writes lives in `.tempo/`, which ignores itself.

**Do not gate a generator on mtimes inside its own body.** That was the v1 pattern; the engine
does it now, and doing it twice means a stale artifact survives a `--no-cache` run.

## Dev sessions

A persistent task with a `watch` spec runs under a supervisor that restarts it when its files
change, re-running its `needs` first.

```ts
task({ name: "api:dev-build", body: ["cargo", "build", "-p", "server"] }),
task({
  name: "api:dev",
  body: ["./target/debug/server"],
  tags: ["dev"],
  persistent: true,
  needs: ["api:dev-build"],
  watch: {
    paths: ["crates/server/src", "migrations"],
    exts: [".rs", ".sql"],
    interrupt: true,
    debounce: 300,
  },
  readyWhen: async () => {
    try {
      const res = await fetch("http://127.0.0.1:8080/health", { signal: AbortSignal.timeout(1000) });
      return res.ok;
    } catch {
      return false;
    }
  },
  readyPollMs: 150,
}),
task({
  name: "web:dev",
  body: ["bun", "run", "dev"],
  cwd: "packages/web",
  tags: ["dev"],
  persistent: true,
  // Waits for readyWhen, so vite never proxies to a backend that has not bound its listener.
  needs: ["api:dev"],
}),
```

`interrupt: true` is **mandatory** whenever the rebuild rewrites the running binary: a live
executable cannot be replaced in place. Without it, tempo rebuilds first and swaps after, which
is what you want when a failed build should cost nothing.

Set `exitBehavior: "first-exits"` on the `dev` command so the whole session ends when one
process does.

## Presets

Presets generate tasks. Nothing they return is privileged.

```ts
...presets.rust({
  name: "api",
  override: {
    lint: "cargo clippy --all-targets --all-features -- -D warnings",
    build: false,   // drop it entirely
  },
})
```

An override naming a task the preset does not produce is an error, not a silent no-op.

| Preset | Tasks |
|---|---|
| `presets.rust` | `format`, `format-fix`, `lint`, `test`, `build` |
| `presets.biome` | `format`, `format-fix`, `lint`, `build`; `type-check`/`test` via `svelte`/`vitest` |
| `presets.go` | `format`, `format-fix`, `lint`, `build`, `test` |
| `presets.gradle` | `format`, `format-fix`, `lint`, `compile`, `test` |

Shared options: `name`, `cwd`, `override`, `tags`, `lock`.

**Presets have no `env` option.** When a toolchain needs one (`SQLX_OFFLINE=true`), override
the body with an env-prefixed string — tempo runs it through a shell — or write the tasks by
hand. A preset earns its keep for a homogeneous toolchain; a bespoke web setup where nearly
everything is overridden is clearer written out.

## Commands

```ts
commands: {
  check: { description: "...", tags: ["check"] },
  fmt: { description: "...", tags: ["format"], concurrency: 1 },
  dev: { description: "...", tags: ["dev"], exitBehavior: "first-exits" },
  deploy: { description: "...", tasks: ["deploy:run"] },
}
```

| Field | Meaning |
|---|---|
| `tags` / `tasks` | What the command selects. Both may be given. |
| `concurrency` | Cap for this command. Use `1` for formatters that write the same files. |
| `exitBehavior` | `first-exits` ends the run when the first persistent task exits. |
| `requirementPolicy` | `skip` \| `warn` \| `fail`. Defaults to `fail` under CI. |
| `passthrough` | Positionals are arguments, not selectors. |

Positional arguments normally **narrow** a selection (`tempo check web`), and narrowing keeps
dependencies: a narrowed run still pulls in what the surviving tasks need, and `always: true`
tasks survive it.

### Commands that take arguments

There are no per-command flags. A command whose arguments are its own point sets
`passthrough: true`, and the task reads `ctx.args`:

```ts
task({
  name: "kb:selfplay",
  body: ["go", "run", "./cmd/kbctl", "selfplay"],
  passthrough: true,
}),
// commands: { selfplay: { tasks: ["kb:selfplay"], passthrough: true } }
// Invoked as: tempo selfplay -- --noise 0.2 --model random
```

For subcommand-style verbs (`tempo db -- start|reset|rm`), branch on `ctx.args[0]` in a
function body and `ctx.fail()` on an unknown one.

## Function bodies

`ctx` gives logic somewhere better to go than a shell:

| Member | Use |
|---|---|
| `ctx.run(argv, opts?)` | Run a command for its exit code. |
| `ctx.capture(argv, opts?)` | Run and collect `{ stdout, stderr, code }`. |
| `ctx.log(message)` | A line attributed to this task. |
| `ctx.fail(message)` | Abort with a message rather than a stack trace. |
| `ctx.cwd` | The directory this task runs in. |
| `ctx.args` | Passthrough arguments, empty unless the task declares `passthrough`. |
| `ctx.signal` | Aborted on Ctrl-C; pass it to `fetch`. |

`opts` accepts `{ cwd, env }`, with `cwd` resolved against the task's own directory.

## Locking

`lock: true` serializes a task against every other tempo process in the project — for a tool
whose incremental cache corrupts when two invocations race. A string names its own lock file,
so tasks contending for one cache can share a lock without taking the rest. A blocked task
waits rather than failing, and the wait is reported beside the work, never charged to it:

```
✓ mod:verify (41.2s, waited 12.8s)
```

## CLI

```bash
tempo check              # everything tagged check
tempo check web api      # narrowed, dependencies preserved
tempo list               # every task with tags and dependencies
tempo run web:types      # specific tasks by name
```

Global flags are extracted before the command, so `--` survives: `--config <path>`,
`--dry-run`, `--json`, `-c/--concurrency <n>`, `--no-cache`.

`--dry-run` prints the layers, which is the fastest way to check that an edge landed where you
meant it. `--json` emits the raw record stream on stdout.

## Conventions

**One namespace per component**, matching what `tempo check <name>` should narrow to.

**Formatters that write the same files need an `after` edge**, not just `concurrency: 1`:

```ts
task({ name: "app:lint-fix", body: "...", tags: ["format"], after: ["app:format-fix"] })
```

**A repo-wide formatter is one task, not one per package.** If a single `biome.json` is the
authority, per-package steps miss root files.

**Advisory audits want `always: true`.** Advisories move without the tree changing, so they
should survive `tempo check <one-component>`.

**Prefer argv arrays for anything long-lived.** A string with shell metacharacters runs under
`sh -c`, and on Debian `/bin/sh` is dash, which does not forward SIGTERM.

**Do not wrap a script tempo would only forward to.** A tempo hop costs ~110ms; if a command
passes its arguments through unchanged and adds nothing, let the Justfile call the script.

## Anti-patterns

- **`ctx` probing that `requires` already covers.** `if (!hasTool("air")) fail(...)` is
  `requires: [{ tool: "air" }]`.
- **mtime gating inside a generator body.** Use `inputs`/`outputs`.
- **Bun-only APIs in a config that Node might load.** `import.meta.dir` is `undefined` under
  Node; use `import.meta.dirname`. A project with no `bun.lock` runs the config under Node.
- **A `needs` edge where `after` was meant.** If the dependent should still run when the
  dependency fails, it is `after`.
- **Reaching for a shell to do string work.** A function body with `ctx.capture` is clearer
  and gets proper output attribution.

## Removed in 0.2.0

`subsystems`, `runners.*`, `preflights`, `hooks`, `autoFix`, `defineCommand`, and the
`proc` / `preflight` / `targets` / `watch` / `octocov` subpaths are gone. The only exports are
`@xevion/tempo`, `@xevion/tempo/engine`, and `@xevion/tempo/fmt`.

| Was | Now |
|---|---|
| `subsystems: { web: { commands: {...} } }` | one `task` per command, named `web:*` |
| `runners.check()` | `commands.check = { tags: ["check"] }` |
| `preflights` | tasks with `inputs`/`outputs` |
| `hooks["before:check"]` | a task others declare `after` |
| `autoFix` | a `format` task the `fmt` command selects |
| `alwaysRun` | `always: true` |
| `dev.processes` | `persistent: true` tasks tagged `dev` |
| `dependsOn` | `needs`, released on `readyWhen` |
| `parameters` / `flags` | `passthrough: true` and `ctx.args` |
