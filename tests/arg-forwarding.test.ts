import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Regression: custom commands must receive positional args via ctx.args and
// post-`--` tokens via ctx.passthrough (previously both were silently empty).
const REPO_ROOT = resolve(import.meta.dir, "..");
const CLI = resolve(REPO_ROOT, "src/cli.ts");

let workDir: string;

beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), "tempo-arg-fwd-"));

	const config = `import { defineConfig } from "${REPO_ROOT}/src/index.ts";

export default defineConfig({
	subsystems: {
		noop: { commands: { lint: "true" } },
	},
	commands: {
		named: {
			description: "named positional params",
			parameters: ["[filter]", "[platform]", "[multiplier]"],
			run: async (ctx) => {
				console.log(JSON.stringify({ args: ctx.args, passthrough: ctx.passthrough }));
				return 0;
			},
		},
		forward: {
			description: "passthrough after --",
			parameters: ["--", "[args...]"],
			run: async (ctx) => {
				console.log(JSON.stringify({ args: ctx.args, passthrough: ctx.passthrough }));
				return 0;
			},
		},
	},
});
`;
	writeFileSync(join(workDir, "tempo.config.ts"), config);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function runCli(args: string[]): { args: string[]; passthrough: string[] } {
	const result = spawnSync("bun", ["run", CLI, ...args], {
		cwd: workDir,
		env: { ...process.env, CI: "", FORCE_COLOR: "0", NO_COLOR: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdout = result.stdout?.toString() ?? "";
	const line = stdout.split("\n").find((l) => l.trim().startsWith("{"));
	if (!line) {
		throw new Error(
			`no JSON output; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(
				result.stderr?.toString() ?? "",
			)}`,
		);
	}
	return JSON.parse(line);
}

describe("custom command arg forwarding", () => {
	test("named positional parameters reach ctx.args", () => {
		const out = runCli(["named", "flatWalk*", "fabric", "5"]);
		expect(out.args).toEqual(["flatWalk*", "fabric", "5"]);
		expect(out.passthrough).toEqual([]);
	});

	test("omitted trailing named params yield the args actually given", () => {
		const out = runCli(["named", "flatWalk*"]);
		expect(out.args).toEqual(["flatWalk*"]);
	});

	test("post-`--` tokens reach ctx.passthrough, not ctx.args", () => {
		const out = runCli(["forward", "--", "list", "foo/bar"]);
		expect(out.passthrough).toEqual(["list", "foo/bar"]);
		expect(out.args).toEqual([]);
	});
});
