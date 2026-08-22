/** Verifies the `bun build --compile` distribution: zero-install configs and clear errors. */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };
import { versionAtLeast } from "../scripts/version.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// Bun.isStandaloneExecutable, which the compiled binary needs to detect itself
// at runtime, does not exist before this version.
const MIN_BUN_VERSION = "1.4.0";
const bunSupportsCompile =
	"Bun" in globalThis && versionAtLeast(Bun.version, MIN_BUN_VERSION);

const BUILD_TIMEOUT_MS = 300_000;

/**
 * A config that imports every @xevion/tempo subpath, presets included, and
 * node:* builtins, and nothing else, so it needs no node_modules to run.
 */
const ZERO_INSTALL_CONFIG = `import { defineConfig, presets, task } from "@xevion/tempo";
import { EXIT_SIGINT } from "@xevion/tempo/fmt";
import { Graph } from "@xevion/tempo/engine";

export default defineConfig({
	tasks: [
		...presets.biome(),
		task({ name: "hello", body: () => (EXIT_SIGINT, Graph, 0), tags: ["check"] }),
	],
	commands: { check: { tags: ["check"] } },
});
`;

/** A config reaching for a package the binary has no node_modules to find. */
const UNSUPPORTED_IMPORT_CONFIG = `import { defineConfig, task } from "@xevion/tempo";
import notReal from "this-package-does-not-exist";

export default defineConfig({
	tasks: [task({ name: "hello", body: () => (notReal, 0), tags: ["check"] })],
	commands: { check: { tags: ["check"] } },
});
`;

let binary: string | null = null;
let buildFailure: Error | null = null;

function buildCompiledBinary(): string {
	const result = spawnSync("bun", ["run", "build:compile"], {
		cwd: REPO_ROOT,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		throw new Error(
			`build:compile failed (${result.status}): ${result.stdout?.toString()}${result.stderr?.toString()}`,
		);
	}
	return join(REPO_ROOT, "bin", "tempo");
}

/** Build once; every test below reuses the same binary. */
function compiledBinary(): string {
	if (buildFailure) throw buildFailure;
	if (!binary) {
		try {
			binary = buildCompiledBinary();
		} catch (error) {
			buildFailure = error instanceof Error ? error : new Error(String(error));
			throw buildFailure;
		}
	}
	return binary;
}

const tempDirs: string[] = [];

/** A directory with nothing but the given config: no package.json, no node_modules. */
function zeroInstallProject(config: string): string {
	const dir = mkdtempSync(join(tmpdir(), "tempo-compiled-"));
	tempDirs.push(dir);
	writeFileSync(join(dir, "tempo.config.ts"), config);
	return dir;
}

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("compiled binary", () => {
	test.skipIf(!bunSupportsCompile)(
		"runs a zero-install config with no node_modules or package.json",
		() => {
			const bin = compiledBinary();
			const dir = zeroInstallProject(ZERO_INSTALL_CONFIG);
			const result = spawnSync(bin, ["list"], {
				cwd: dir,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const stdout = result.stdout?.toString() ?? "";
			const stderr = result.stderr?.toString() ?? "";
			if (result.status !== 0) {
				throw new Error(`list failed (${result.status}): ${stdout}${stderr}`);
			}
			// listTasks writes to stderr, keeping stdout clean for --json output.
			// presets.biome() defaults its prefix to "web".
			expect(stderr).toContain("hello");
			expect(stderr).toContain("web:lint");
		},
		BUILD_TIMEOUT_MS,
	);

	test.skipIf(!bunSupportsCompile)(
		"runs the selected tasks end to end",
		() => {
			const bin = compiledBinary();
			const dir = zeroInstallProject(ZERO_INSTALL_CONFIG);
			const result = spawnSync(bin, ["run", "hello"], {
				cwd: dir,
				stdio: ["ignore", "pipe", "pipe"],
			});
			if (result.status !== 0) {
				throw new Error(
					`run failed (${result.status}): ${result.stdout?.toString()}${result.stderr?.toString()}`,
				);
			}
		},
		BUILD_TIMEOUT_MS,
	);

	test.skipIf(!bunSupportsCompile)(
		"names the unresolved import and how to work around it",
		() => {
			const bin = compiledBinary();
			const dir = zeroInstallProject(UNSUPPORTED_IMPORT_CONFIG);
			const result = spawnSync(bin, ["list"], {
				cwd: dir,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const stderr = result.stderr?.toString() ?? "";
			expect(result.status).toBe(1);
			expect(stderr).toContain('"this-package-does-not-exist"');
			expect(stderr).toContain("compiled tempo binary cannot resolve");
			expect(stderr).toContain("Install tempo from npm");
		},
		BUILD_TIMEOUT_MS,
	);

	test("embeds every published export subpath", () => {
		// register.standalone.ts hand-lists these specifiers, since a `with { type:
		// "text" }` import must be a static literal; this keeps that list honest.
		expect(Object.keys(pkg.exports).sort()).toEqual([".", "./engine", "./fmt"]);
	});
});
