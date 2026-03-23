/**
 * Cross-runtime compatibility tests.
 *
 * Verifies that tempo's public API surface can be imported and used
 * under Node.js and Deno in addition to Bun.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

/** All public subpath exports that must be importable */
const SUBPATH_EXPORTS = [
	"./src/index.ts",
	"./src/proc.ts",
	"./src/fmt.ts",
	"./src/preflight.ts",
	"./src/targets.ts",
	"./src/watch.ts",
	"./src/octocov.ts",
	"./src/config.ts",
];

/** In CI (TEMPO_CI_COMPAT=1), all runtimes must be present — no skipping. */
const strictCompat = process.env.TEMPO_CI_COMPAT === "1";

function hasRuntime(cmd: string): boolean {
	try {
		const result = spawnSync("which", [cmd], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		return result.status === 0;
	} catch {
		return false;
	}
}

function requireRuntime(name: string, available: boolean): boolean {
	if (strictCompat && !available) {
		throw new Error(
			`${name} is required in CI (TEMPO_CI_COMPAT=1) but was not found on PATH`,
		);
	}
	return available;
}

function nodeImportTest(modulePath: string): { ok: boolean; error?: string } {
	const script = `import('./${modulePath}').then(() => process.exit(0)).catch(e => { process.stderr.write(e.message); process.exit(1); })`;
	const result = spawnSync(
		"node",
		[
			"--experimental-strip-types",
			"--experimental-detect-module",
			"-e",
			script,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	if (result.status === 0) return { ok: true };
	return { ok: false, error: result.stderr?.toString() ?? "unknown error" };
}

function denoImportTest(modulePath: string): { ok: boolean; error?: string } {
	const script = `import('./${modulePath}').then(() => Deno.exit(0)).catch(e => { Deno.stderr.writeSync(new TextEncoder().encode(e.message)); Deno.exit(1); })`;
	const result = spawnSync("deno", ["eval", "--ext=ts", script], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, DENO_NO_PROMPT: "1" },
	});
	if (result.status === 0) return { ok: true };
	return { ok: false, error: result.stderr?.toString() ?? "unknown error" };
}

describe("cross-runtime: bun", () => {
	for (const mod of SUBPATH_EXPORTS) {
		test(`import ${mod}`, async () => {
			const m = await import(`../${mod}`);
			expect(m).toBeDefined();
			expect(Object.keys(m).length).toBeGreaterThan(0);
		});
	}
});

const hasNode = requireRuntime("node", hasRuntime("node"));
describe("cross-runtime: node", () => {
	test.skipIf(!hasNode)("node is available", () => {
		const result = spawnSync("node", ["--version"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const version = result.stdout?.toString().trim() ?? "";
		// Node 22+ required for --experimental-strip-types
		const major = Number.parseInt(version.replace("v", "").split(".")[0], 10);
		expect(major).toBeGreaterThanOrEqual(22);
	});

	for (const mod of SUBPATH_EXPORTS) {
		test.skipIf(!hasNode)(`import ${mod}`, () => {
			const result = nodeImportTest(mod);
			if (!result.ok) {
				throw new Error(`Node failed to import ${mod}: ${result.error}`);
			}
		});
	}
});

const hasDeno = requireRuntime("deno", hasRuntime("deno"));
describe("cross-runtime: deno", () => {
	test.skipIf(!hasDeno)("deno is available", () => {
		const result = spawnSync("deno", ["--version"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		expect(result.status).toBe(0);
	});

	for (const mod of SUBPATH_EXPORTS) {
		test.skipIf(!hasDeno)(`import ${mod}`, () => {
			const result = denoImportTest(mod);
			if (!result.ok) {
				throw new Error(`Deno failed to import ${mod}: ${result.error}`);
			}
		});
	}
});

describe("no bun-specific APIs in source", () => {
	test("no Bun.* references outside runtime guards", async () => {
		const { globSync } = await import("node:fs");
		const { readFileSync } = await import("node:fs");

		const files = globSync("src/**/*.ts");
		const violations: string[] = [];

		for (const file of files) {
			const content = readFileSync(file, "utf-8");
			const lines = content.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				// Skip lines inside runtime guards (allow dynamic import("bun"))
				if (line.includes('import("bun")')) continue;
				if (/\bBun\./.test(line)) {
					violations.push(`${file}:${i + 1}: ${line.trim()}`);
				}
			}
		}

		expect(violations).toEqual([]);
	});

	test('no static import from "bun"', async () => {
		const { globSync, readFileSync } = await import("node:fs");

		const files = globSync("src/**/*.ts");
		const violations: string[] = [];

		for (const file of files) {
			const content = readFileSync(file, "utf-8");
			// Match static imports like: import { plugin } from "bun"
			// But not dynamic: await import("bun")
			const staticImport = /^import\s.*from\s+["']bun["']/m;
			if (staticImport.test(content)) {
				violations.push(file);
			}
		}

		expect(violations).toEqual([]);
	});
});
