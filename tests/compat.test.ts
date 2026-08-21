/** Verifies the public API surface imports and runs under Node and Deno, not just Bun. */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const pkg = JSON.parse(
	readFileSync(join(REPO_ROOT, "package.json"), "utf-8"),
) as { name: string; version: string };

/** npm's tarball naming: @scope/name becomes scope-name-version.tgz */
const TARBALL = `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`;

/** Packing, installing and running the tarball is far slower than a unit test. */
const PACK_TIMEOUT_MS = 300_000;

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
			// Static `import { plugin } from "bun"`, not dynamic `await import("bun")`.
			const staticImport = /^import\s.*from\s+["']bun["']/m;
			if (staticImport.test(content)) {
				violations.push(file);
			}
		}

		expect(violations).toEqual([]);
	});
});

/** Invocations of the raw TS entrypoint, one per runtime. */
const CLI_RUNTIMES = [
	{ name: "bun", cmd: "bun", args: ["run", "src/cli.ts"], available: true },
	{
		name: "node",
		cmd: "node",
		args: ["--experimental-strip-types", "src/cli.ts"],
		available: hasNode,
	},
	{
		name: "deno",
		cmd: "deno",
		args: ["run", "-A", "src/cli.ts"],
		available: hasDeno,
	},
];

describe("cli entrypoint: source", () => {
	for (const runtime of CLI_RUNTIMES) {
		// TEMPO_REEXEC pins the runtime under test, which would otherwise hand off to bun.
		test.skipIf(!runtime.available)(
			`${runtime.name} executes src/cli.ts`,
			() => {
				const result = spawnSync(runtime.cmd, [...runtime.args, "--version"], {
					cwd: REPO_ROOT,
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env, TEMPO_REEXEC: "1", NO_COLOR: "1" },
				});
				if (result.status !== 0) {
					throw new Error(
						`${runtime.name} failed to execute src/cli.ts: ${result.stderr?.toString()}`,
					);
				}
				expect(result.stdout?.toString() ?? "").toContain(pkg.version);
			},
		);
	}
});

/** Consumer config exercising the public entrypoint and reporting its runtime. */
const PROBE_CONFIG = `import { defineConfig } from "@xevion/tempo";

export default defineConfig({
	subsystems: {
		probe: { commands: { check: "true" } },
	},
	commands: {
		probe: {
			description: "Report which runtime is executing tempo",
			// ctx is unannotated on purpose: it must be contextually typed, not implicitly any.
			run: (ctx) => {
				const runtime =
					"Bun" in globalThis ? "bun" : "Deno" in globalThis ? "deno" : "node";
				const suffix: string = ctx.args.join(",");
				process.stdout.write("PROBE:" + runtime + suffix + "\\n");
				return 0;
			},
		},
		group: {
			nested: (ctx) => ctx.passthrough.length,
		},
	},
});
`;

/** skipLibCheck stays off so shipped declarations are checked, not skipped. */
const CONSUMER_TSCONFIG = `${JSON.stringify(
	{
		compilerOptions: {
			target: "ESNext",
			module: "nodenext",
			moduleResolution: "nodenext",
			strict: true,
			noEmit: true,
			skipLibCheck: false,
			types: ["node"],
		},
		include: ["tempo.config.ts"],
	},
	null,
	2,
)}\n`;

type PackagedInstall = { dir: string; bin: string };

let packaged: PackagedInstall | null = null;
let packagedFailure: Error | null = null;

function checkedSpawn(
	label: string,
	cmd: string,
	args: string[],
	cwd: string,
): void {
	const result = spawnSync(cmd, args, {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		// tsc reports on stdout, bun and npm on stderr, so surface both.
		const output = [result.stdout?.toString(), result.stderr?.toString()]
			.filter(Boolean)
			.join("\n");
		throw new Error(`${label} failed (${result.status}): ${output}`);
	}
}

function createPackagedInstall(): PackagedInstall {
	checkedSpawn("bun run build", "bun", ["run", "build"], REPO_ROOT);

	const dir = mkdtempSync(join(tmpdir(), "tempo-pack-"));
	checkedSpawn(
		"npm pack",
		"npm",
		["pack", "--pack-destination", dir],
		REPO_ROOT,
	);

	const manifest = {
		name: "tempo-pack-smoke",
		private: true,
		type: "module",
		dependencies: { [pkg.name]: `file:./${TARBALL}` },
		// @types/node is an optional peer, so consumers supply it themselves.
		devDependencies: { "@types/node": pkg.peerDependencies["@types/node"] },
	};
	writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2));
	writeFileSync(join(dir, "tempo.config.ts"), PROBE_CONFIG);
	writeFileSync(join(dir, "tsconfig.json"), CONSUMER_TSCONFIG);

	checkedSpawn(
		"npm install",
		"npm",
		["install", "--no-audit", "--no-fund"],
		dir,
	);

	return { dir, bin: join(dir, "node_modules", ".bin", "tempo") };
}

/** Build, pack and install once; every packaged test reuses the same install. */
function packagedInstall(): PackagedInstall {
	if (packagedFailure) throw packagedFailure;
	if (!packaged) {
		try {
			packaged = createPackagedInstall();
		} catch (error) {
			packagedFailure =
				error instanceof Error ? error : new Error(String(error));
			throw packagedFailure;
		}
	}
	return packaged;
}

function runProbe(
	cmd: string,
	args: string[],
	dir: string,
	env: NodeJS.ProcessEnv,
): string {
	const result = spawnSync(cmd, args, {
		cwd: dir,
		stdio: ["ignore", "pipe", "pipe"],
		env,
	});
	const stdout = result.stdout?.toString() ?? "";
	if (result.status !== 0) {
		throw new Error(
			`${cmd} failed to run the packaged CLI (${result.status}): ${stdout}${result.stderr?.toString()}`,
		);
	}
	return stdout;
}

function toolPath(cmd: string): string {
	const result = spawnSync("which", [cmd], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	return (result.stdout?.toString() ?? "").trim();
}

afterAll(() => {
	if (packaged) rmSync(packaged.dir, { recursive: true, force: true });
});

const hasNpm = requireRuntime("npm", hasRuntime("npm"));

describe("cli entrypoint: packaged", () => {
	test.skipIf(!hasNpm)(
		"the installed bin runs a config that imports the package",
		() => {
			const { dir, bin } = packagedInstall();
			const stdout = runProbe(bin, ["probe"], dir, {
				...process.env,
				NO_COLOR: "1",
			});
			expect(stdout).toContain("PROBE:");
		},
		PACK_TIMEOUT_MS,
	);

	test.skipIf(!hasNpm)(
		"the shipped declarations type check from a consumer project",
		() => {
			const { dir } = packagedInstall();
			const tsc = join(REPO_ROOT, "node_modules", ".bin", "tsc");
			const result = spawnSync(tsc, ["--noEmit", "-p", "tsconfig.json"], {
				cwd: dir,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const diagnostics = `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`;
			if (result.status !== 0) {
				throw new Error(`consumer type check failed:\n${diagnostics}`);
			}
			expect(diagnostics.trim()).toBe("");
		},
		PACK_TIMEOUT_MS,
	);

	test.skipIf(!hasNpm)(
		"node runs the packaged bin",
		() => {
			const { dir, bin } = packagedInstall();
			const stdout = runProbe("node", [bin, "probe"], dir, {
				...process.env,
				TEMPO_REEXEC: "1",
				NO_COLOR: "1",
			});
			expect(stdout).toContain("PROBE:node");
		},
		PACK_TIMEOUT_MS,
	);

	test.skipIf(!hasNpm || !hasDeno)(
		"deno runs the packaged bin",
		() => {
			const { dir } = packagedInstall();
			const target = join(dir, "node_modules", pkg.name, "dist", "cli.mjs");
			const stdout = runProbe("deno", ["run", "-A", target, "probe"], dir, {
				...process.env,
				TEMPO_REEXEC: "1",
				NO_COLOR: "1",
				DENO_NO_PROMPT: "1",
			});
			expect(stdout).toContain("PROBE:deno");
		},
		PACK_TIMEOUT_MS,
	);

	test.skipIf(!hasNpm)(
		"node re-execs under bun when the project has a bun lockfile",
		() => {
			const { dir, bin } = packagedInstall();
			const lockfile = join(dir, "bun.lock");
			writeFileSync(lockfile, "");
			try {
				const env = { ...process.env, NO_COLOR: "1" };
				delete env.TEMPO_REEXEC;
				expect(runProbe("node", [bin, "probe"], dir, env)).toContain(
					"PROBE:bun",
				);
			} finally {
				rmSync(lockfile, { force: true });
			}
		},
		PACK_TIMEOUT_MS,
	);

	// The bin's shebang must fall back to bun; a hard-coded node shebang exits 127 here.
	test.skipIf(!hasNpm)(
		"the installed bin runs with node absent from PATH",
		() => {
			const { dir, bin } = packagedInstall();
			const shimDir = join(dir, "bun-only-bin");
			mkdirSync(shimDir, { recursive: true });
			for (const tool of ["sh", "bun"]) {
				const resolved = toolPath(tool);
				expect(resolved).not.toBe("");
				symlinkSync(resolved, join(shimDir, tool));
			}
			const stdout = runProbe(bin, ["probe"], dir, {
				PATH: shimDir,
				HOME: process.env.HOME ?? dir,
				TMPDIR: tmpdir(),
				NO_COLOR: "1",
			});
			expect(stdout).toContain("PROBE:bun");
		},
		PACK_TIMEOUT_MS,
	);
});
