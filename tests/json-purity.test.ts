import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Commands exercised end-to-end under --json. Every stdout byte must be
// parseable JSON Lines with a known `type` discriminator — no ANSI escapes,
// no raw human text, no terminal resets.
const KNOWN_TYPES = new Set(["log", "output", "result", "skip", "summary"]);

const REPO_ROOT = resolve(import.meta.dir, "..");
const CLI = resolve(REPO_ROOT, "src/cli.ts");

let workDir: string;

beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), "tempo-json-purity-"));

	const config = `import { defineConfig, runners } from "${REPO_ROOT}/src/index.ts";

export default defineConfig({
	subsystems: {
		passing: {
			commands: {
				"format-check": "true",
				"format-apply": "true",
				lint: "true",
			},
			autoFix: { "format-check": "format-apply" },
		},
		failing: {
			commands: {
				lint: "false",
			},
		},
	},
	commands: {
		check: runners.check({ autoFixStrategy: "fix-on-fail" }),
		fmt: runners.sequential("format-apply", {
			description: "Format",
			autoFixFallback: true,
		}),
	},
});
`;
	writeFileSync(join(workDir, "tempo.config.ts"), config);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function runCli(args: string[]): { stdout: string; code: number } {
	const result = spawnSync("bun", ["run", CLI, ...args, "--json"], {
		cwd: workDir,
		env: { ...process.env, CI: "", FORCE_COLOR: "0", NO_COLOR: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		stdout: result.stdout?.toString() ?? "",
		code: result.status ?? -1,
	};
}

function assertPureJsonLines(stdout: string): void {
	expect(stdout.length).toBeGreaterThan(0);
	// No ANSI escape sequences anywhere in stdout. ESC = U+001B.
	const ESC = String.fromCharCode(0x1b);
	expect(stdout.includes(`${ESC}[`)).toBe(false);
	const lines = stdout.split("\n").filter((l) => l.length > 0);
	expect(lines.length).toBeGreaterThan(0);
	for (const line of lines) {
		let parsed: { type?: unknown };
		try {
			parsed = JSON.parse(line);
		} catch (err) {
			throw new Error(
				`stdout line is not valid JSON: ${JSON.stringify(line)} — ${
					(err as Error).message
				}`,
			);
		}
		expect(typeof parsed.type).toBe("string");
		expect(KNOWN_TYPES).toContain(parsed.type as string);
	}
}

describe("--json stdout purity", () => {
	test("check (passing) emits only JSON lines", () => {
		const { stdout } = runCli(["check", "passing"]);
		assertPureJsonLines(stdout);
	});

	test("check (failing, auto-fix attempted) emits only JSON lines", () => {
		const { stdout } = runCli(["check", "failing"]);
		assertPureJsonLines(stdout);
	});

	test("check (all) emits only JSON lines", () => {
		const { stdout } = runCli(["check"]);
		assertPureJsonLines(stdout);
	});

	test("fmt emits only JSON lines", () => {
		const { stdout } = runCli(["fmt", "passing"]);
		assertPureJsonLines(stdout);
	});
});
