import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Regressions: global flags must stop at `--`, hook cleanups must always drain,
// and identity (`--version`/`--help`) must answer outside a project.
const REPO_ROOT = resolve(import.meta.dir, "..");
const CLI = resolve(REPO_ROOT, "src/cli.ts");

let workDir: string;
let bareDir: string;

beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), "tempo-global-flags-"));
	bareDir = mkdtempSync(join(tmpdir(), "tempo-no-config-"));

	const config = `import { defineConfig } from "${REPO_ROOT}/src/index.ts";

export default defineConfig({
	subsystems: {
		noop: { commands: { lint: "true" } },
	},
	hooks: {
		"before:echo": async (ctx) => {
			ctx.addCleanup(() => { process.stderr.write("CLEANUP-A\\n"); });
			ctx.addCleanup(() => { throw new Error("cleanup exploded"); });
			ctx.addCleanup(() => { process.stderr.write("CLEANUP-B\\n"); });
		},
		"before:boom": async (ctx) => {
			ctx.addCleanup(() => { process.stderr.write("CLEANUP-BOOM\\n"); });
		},
	},
	commands: {
		echo: {
			description: "echo args",
			parameters: ["[args...]"],
			run: async (ctx) => {
				console.log(JSON.stringify({ args: ctx.args, passthrough: ctx.passthrough }));
				return 0;
			},
		},
		boom: {
			description: "always throws",
			run: async () => {
				throw new Error("kaboom");
			},
		},
	},
});
`;
	writeFileSync(join(workDir, "tempo.config.ts"), config);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
	rmSync(bareDir, { recursive: true, force: true });
});

function runCli(
	args: string[],
	cwd: string,
): { stdout: string; stderr: string; code: number } {
	const result = spawnSync("bun", ["run", CLI, ...args], {
		cwd,
		env: { ...process.env, CI: "", FORCE_COLOR: "0", NO_COLOR: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		stdout: result.stdout?.toString() ?? "",
		stderr: result.stderr?.toString() ?? "",
		code: result.status ?? -1,
	};
}

describe("global flag extraction", () => {
	test("flags after `--` are forwarded, not consumed by tempo", () => {
		const { stdout, code } = runCli(
			["echo", "alpha", "--", "--json", "-v", "--config", "foo", "beta"],
			workDir,
		);
		expect(code).toBe(0);
		const line = stdout.split("\n").find((l) => l.trim().startsWith("{"));
		expect(line).toBeDefined();
		expect(JSON.parse(line as string)).toEqual({
			args: ["alpha"],
			passthrough: ["--json", "-v", "--config", "foo", "beta"],
		});
	});

	test("flags before `--` still reach tempo", () => {
		const { stdout } = runCli(["--json", "echo", "alpha"], workDir);
		const lines = stdout.split("\n").filter((l) => l.length > 0);
		expect(lines.every((l) => l.trim().startsWith("{"))).toBe(true);
	});
});

describe("hook cleanups", () => {
	test("run after a successful command, and a failing one does not block the rest", () => {
		const { stderr, code } = runCli(["echo", "alpha"], workDir);
		expect(code).toBe(0);
		expect(stderr).toContain("CLEANUP-A");
		expect(stderr).toContain("CLEANUP-B");
		expect(stderr).toContain("cleanup exploded");
	});

	test("run after a command throws", () => {
		const { stderr, code } = runCli(["boom"], workDir);
		expect(code).toBe(1);
		expect(stderr).toContain("CLEANUP-BOOM");
	});
});

describe("identity without a config", () => {
	test("--version reports version, build, path and runtime", () => {
		const { stdout, code } = runCli(["--version"], bareDir);
		expect(code).toBe(0);
		expect(stdout).toContain("tempo ");
		expect(stdout).toContain("build");
		expect(stdout).toContain(CLI);
		expect(/runtime\s+(bun|node|deno) /.test(stdout)).toBe(true);
	});

	test("--version under --json emits a single JSON record", () => {
		const { stdout, code } = runCli(["--version", "--json"], bareDir);
		expect(code).toBe(0);
		const lines = stdout.split("\n").filter((l) => l.length > 0);
		expect(lines.length).toBe(1);
		const record = JSON.parse(lines[0] as string);
		expect(record.type).toBe("version");
		expect(record.path).toBe(CLI);
	});

	test("--help renders instead of failing on the missing config", () => {
		const { stdout, code } = runCli(["--help"], bareDir);
		expect(code).toBe(0);
		expect(stdout).toContain("Developer script orchestrator");
	});

	test("a real command still fails on the missing config", () => {
		const { stderr, code } = runCli(["check"], bareDir);
		expect(code).toBe(1);
		expect(stderr).toContain("Could not find tempo.config.ts");
	});
});
