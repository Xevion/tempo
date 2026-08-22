#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { versionAtLeast } from "./version.ts";

// Bun.isStandaloneExecutable, which register.standalone.ts needs to detect a
// compiled binary at runtime, does not exist before this version.
const MIN_BUN_VERSION = "1.4.0";

if (!versionAtLeast(Bun.version, MIN_BUN_VERSION)) {
	process.stderr.write(
		`error building compiled binary: bun ${Bun.version} is installed, but bun >=${MIN_BUN_VERSION} is required.\n` +
			`Bun.isStandaloneExecutable, which the compiled binary needs to detect itself at runtime, does not exist before ${MIN_BUN_VERSION}.\n` +
			"Upgrade with `mise install bun@latest` or `bun upgrade`, then retry.\n",
	);
	process.exit(1);
}

// Outside dist/, which package.json's `files` publishes verbatim: an 80+MB
// standalone binary must never end up in the npm tarball.
mkdirSync("bin", { recursive: true });

// A bundle with every dependency inlined, distinct from dist/'s externalized build:
// the compiled binary has no node_modules for an embedded module to `require()` from.
const embed = spawnSync(
	"bun",
	[
		"build",
		"src/index.ts",
		"src/engine/index.ts",
		"src/fmt.ts",
		"--outdir",
		"bin/embed",
		"--root",
		"src",
		"--target",
		"node",
		"--format",
		"esm",
		"--entry-naming",
		"[dir]/[name].mjs",
	],
	{ stdio: "inherit" },
);
if (embed.status !== 0) process.exit(embed.status ?? 1);

const result = spawnSync(
	"bun",
	[
		"build",
		"--compile",
		"--bytecode",
		"--outfile",
		"bin/tempo",
		"src/cli.standalone.ts",
	],
	{ stdio: "inherit" },
);
process.exit(result.status ?? 1);
