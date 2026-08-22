# @xevion/tempo

A task graph for the scripts a project accumulates: checks, formatters, dev servers, one-off
commands. Works with Bun, Node.js (22+), and Deno.

## Install

```bash
bun add -d @xevion/tempo    # or npm/pnpm/yarn
```

## Quick Start

Create a `tempo.config.ts` in your project root:

```ts
import { defineConfig, presets, task } from "@xevion/tempo";

export default defineConfig({
  tasks: [
    ...presets.biome({ name: "web" }),

    task({ name: "web:types", body: "bunx tsc --noEmit", tags: ["check"] }),

    task({
      name: "web:dev",
      body: "bun run --hot src/index.ts",
      tags: ["dev"],
      persistent: true,
    }),
  ],

  commands: {
    check: { description: "Run every check in parallel", tags: ["check"] },
    fmt: { description: "Apply every formatter", tags: ["format"], concurrency: 1 },
    dev: { description: "Run the dev server", tags: ["dev"] },
  },
});
```

```bash
tempo check          # everything tagged "check", in parallel
tempo check web      # narrowed to one component, dependencies preserved
tempo fmt            # everything tagged "format", one at a time
tempo list           # every task with its tags and dependencies
tempo run web:types  # specific tasks by name
```

## The model

A **task** is the atom: a name, a body, tags, requirements, and edges. A **command** is a
selector over tasks rather than a runner of its own — `check` means "everything tagged
`check`". Adding a task to a tag adds it to the command; there is no second place to register it.

A **body** is a shell string, an argv array, or a TypeScript function, and all three are peers.
A function body gets the same row, timing, cancellation, and JSON record as a spawned process:

```ts
task({
  name: "api:bindings",
  tags: ["check"],
  body: async (ctx) => {
    const { stdout } = await ctx.capture(["cargo", "metadata", "--format-version", "1"]);
    if (!stdout.includes("ts-rs")) ctx.fail("ts-rs is not in the dependency tree");
    await ctx.run(["cargo", "test", "export_bindings"]);
  },
});
```

`needs` and `after` are orthogonal. `needs(x)` requires x to succeed and pulls it into the run;
`after(x)` orders only, and is inert unless x was already selected. Use `after` for a reporting
step that should still run when the thing it reports on failed.

## Caching

Declare what a task reads and writes, and it is skipped while its inputs are unchanged:

```ts
task({
  name: "pkg:build",
  body: "bun run build",
  tags: ["build"],
  inputs: ["src/**/*.ts", "package.json"],
  outputs: ["dist/**/*.mjs"],
});
```

Fingerprints are content hashes, not timestamps, and live in `.tempo/` — which ignores itself,
so nothing reaches your diff. A cache hit satisfies dependents: anything that `needs` this task
proceeds immediately.

## Dev sessions

A persistent task with a `watch` spec runs under a supervisor that restarts it when its files
change, re-running its `needs` first:

```ts
task({
  name: "api:dev",
  body: ["cargo", "run", "-p", "server"],
  tags: ["dev"],
  persistent: true,
  needs: ["api:build"],
  // interrupt: the rebuild rewrites the running binary, so stop before rebuilding.
  watch: { paths: ["src"], exts: [".rs"], interrupt: true },
  readyWhen: async (ctx) => (await ctx.run("curl -sf localhost:8080/health")) === 0,
});
```

`readyWhen` gates dependents on serving rather than on spawning. `interrupt` decides ordering:
stop-then-rebuild when the rebuild would overwrite the running binary, otherwise
rebuild-then-swap so a failed build costs nothing.

## Requirements

A task can declare what its environment must provide. Missing requirements skip the task
locally and fail it under CI, so a machine without a tool loses a check rather than pretending:

```ts
task({
  name: "ci:actionlint",
  body: "actionlint",
  tags: ["check"],
  requires: [{ tool: "actionlint", hint: "brew install actionlint" }],
});
```

`{ tool }`, `{ env }`, and `{ file }` are all accepted.

## Locking

`lock: true` serializes a task against every other tempo process in the project — for a tool
whose incremental cache corrupts when two invocations race. A string names its own lock file, so
tasks contending for one cache can share a lock without taking the rest. A blocked task waits
rather than failing, and the wait is reported beside the work:

```
✓ mod:verify (41.2s, waited 12.8s)
```

## Presets

Presets generate the tasks for a toolchain. `override` replaces a body, or drops the task with
`false`, and naming a task the preset does not produce is an error rather than a silent no-op:

```ts
...presets.rust({
  name: "api",
  override: {
    lint: "cargo clippy --all-targets --all-features -- -D warnings",
    build: false,
  },
})
```

| Preset | Tasks it generates |
|--------|--------------------|
| `presets.rust` | `format`, `format-fix`, `lint`, `test`, `build` |
| `presets.biome` | `format`, `format-fix`, `lint`, `build`, and `type-check`/`test` on request |
| `presets.go` | `format`, `format-fix`, `lint`, `build`, `test` |
| `presets.gradle` | `format`, `format-fix`, `lint`, `compile`, `test` |

## CLI

Global flags are parsed before the command, so `--` and everything after it survives:

| Flag | Effect |
|------|--------|
| `--config <path>` | Use a specific config |
| `--dry-run` | Print the layers that would run |
| `--json` | Emit the raw engine record stream as JSON Lines on stdout |
| `-c, --concurrency <n>` | Cap parallel tasks |
| `--no-cache` | Ignore fingerprints |

`--json` is the engine's own record stream, not a rendering of it: stdout carries records and
nothing else, so it stays parseable while a task is writing to the terminal.

## Exports

```ts
import { defineConfig, presets, task } from "@xevion/tempo";
import { Graph, run, supervise } from "@xevion/tempo/engine";
import { c, elapsed } from "@xevion/tempo/fmt";
```

`@xevion/tempo/engine` is the graph and scheduler on their own, for driving the engine without
the CLI.

## Global installs

A config can `import` from `@xevion/tempo` even when the package is not in the project's
`node_modules` — the CLI registers itself as a virtual module, so a globally installed tempo
works in a project with no `package.json` at all. Type information still needs a real
devDependency, since the compiler cannot see a module that only exists at runtime.

## License

[LGPL-3.0-or-later](LICENSE)
