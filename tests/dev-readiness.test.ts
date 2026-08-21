import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Regression: a dev process with `dependsOn` must wait for the dependency's
// `readyCheck` to pass before spawning, not just for the dependency to spawn.
const REPO_ROOT = resolve(import.meta.dir, "..");
const CLI = resolve(REPO_ROOT, "src/cli.ts");

let workDir: string;
let logFile: string;

function markExpr(label: string, log: string): string {
	return (
		"require('fs').appendFileSync(" +
		JSON.stringify(log) +
		", " +
		JSON.stringify(label) +
		" + ' ' + Date.now() + '\\n')"
	);
}

beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), "tempo-dev-readiness-"));
	logFile = join(workDir, "order.log");

	const configLines = [
		"import { defineConfig, runners } from " +
			JSON.stringify(resolve(REPO_ROOT, "src/index.ts")) +
			";",
		"",
		"const START = Date.now();",
		"",
		"export default defineConfig({",
		"\tsubsystems: {",
		'\t\tbackend: { commands: { lint: "true" } },',
		'\t\tweb: { commands: { lint: "true" } },',
		"\t},",
		"\tdev: {",
		'\t\texitBehavior: "all-exit",',
		"\t\tprocesses: {",
		"\t\t\tbackend: {",
		'\t\t\t\ttype: "unmanaged",',
		'\t\t\t\tcmd: ["bun", "-e", ' +
			JSON.stringify(markExpr("backend", logFile)) +
			"],",
		"\t\t\t\treadyCheck: async () => Date.now() - START >= 300,",
		"\t\t\t\treadyPollMs: 20,",
		"\t\t\t},",
		"\t\t\tweb: {",
		'\t\t\t\ttype: "unmanaged",',
		'\t\t\t\tdependsOn: ["backend"],',
		'\t\t\t\tcmd: ["bun", "-e", ' +
			JSON.stringify(markExpr("web", logFile)) +
			"],",
		"\t\t\t},",
		"\t\t},",
		"\t},",
		"\tcommands: {",
		"\t\tdev: runners.dev(),",
		"\t},",
		"});",
		"",
	];
	writeFileSync(join(workDir, "tempo.config.ts"), configLines.join("\n"));
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("dev process readiness ordering", () => {
	test("dependsOn waits for the dependency's readyCheck before spawning", () => {
		spawnSync("bun", ["run", CLI, "dev"], {
			cwd: workDir,
			env: { ...process.env, CI: "", FORCE_COLOR: "0", NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
		});

		const lines = readFileSync(logFile, "utf8").trim().split("\n");
		const times: Record<string, number> = {};
		for (const line of lines) {
			const [label, ts] = line.split(" ");
			if (label) times[label] = Number(ts);
		}

		expect(times.backend).toBeDefined();
		expect(times.web).toBeDefined();
		expect(
			(times.web as number) - (times.backend as number),
		).toBeGreaterThanOrEqual(250);
	});
});
