import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CLI = resolve(REPO_ROOT, "src/cli.ts");
const CLEAN_ENV = { ...process.env, CI: "", FORCE_COLOR: "0", NO_COLOR: "1" };

interface SummaryRecord {
	type: string;
	passed: number;
	total: number;
	hasFailure: boolean;
}

function lastSummary(stdout: string): SummaryRecord | undefined {
	const records = stdout
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as SummaryRecord);
	return records.filter((r) => r.type === "summary").pop();
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return false;
}

/** Resolve with the child's exit status, or nulls if it outlives the deadline */
function waitForExit(
	proc: ChildProcess,
	timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve) => {
		const timer = setTimeout(
			() => resolve({ code: null, signal: null }),
			timeoutMs,
		);
		proc.on("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
	});
}

describe("check fix-on-fail exit code", () => {
	let workDir: string;

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "tempo-fix-on-fail-"));
		// alpha:verify is fixable (autoFix maps it to alpha:fix); beta:verify is not.
		const config = `import { defineConfig, runners } from "${REPO_ROOT}/src/index.ts";

export default defineConfig({
	subsystems: {
		alpha: {
			commands: {
				verify: "test -f fixed.marker",
				fix: "touch fixed.marker",
			},
			autoFix: { verify: "fix" },
		},
		beta: {
			commands: { verify: "false" },
		},
	},
	commands: {
		check: runners.check({
			autoFixStrategy: "fix-on-fail",
			exclude: ["alpha:fix"],
		}),
	},
});
`;
		writeFileSync(join(workDir, "tempo.config.ts"), config);
	});

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	test("a failure with no auto-fix still exits non-zero", () => {
		const result = spawnSync("bun", [CLI, "check", "--fix", "--json"], {
			cwd: workDir,
			env: CLEAN_ENV,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout = result.stdout?.toString() ?? "";
		const summary = lastSummary(stdout);

		expect(result.status).toBe(1);
		expect(summary?.hasFailure).toBe(true);
		expect(summary?.passed).toBe(1);
		expect(summary?.total).toBe(2);
	}, 30000);
});

describe("check signal handling", () => {
	let workDir: string;

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "tempo-check-signal-"));
		// `exec` makes sleep the tracked child, so killing the child kills the sleep.
		const config = `import { defineConfig, runners } from "${REPO_ROOT}/src/index.ts";

export default defineConfig({
	subsystems: {
		slow: {
			commands: { verify: "touch started.marker; exec sleep 30" },
		},
	},
	commands: { check: runners.check() },
});
`;
		writeFileSync(join(workDir, "tempo.config.ts"), config);
	});

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	test("SIGINT terminates running checks and exits 130", async () => {
		const proc = spawn("bun", [CLI, "check", "--json"], {
			cwd: workDir,
			env: CLEAN_ENV,
			stdio: ["ignore", "pipe", "pipe"],
		});
		proc.stdout?.resume();
		proc.stderr?.resume();
		const exited = waitForExit(proc, 20000);

		try {
			const started = await waitForFile(join(workDir, "started.marker"), 15000);
			expect(started).toBe(true);

			const t0 = Date.now();
			proc.kill("SIGINT");
			const outcome = await exited;

			// tempo must handle the signal itself, not die from the default action
			expect(outcome.signal).toBe(null);
			expect(outcome.code).toBe(130);
			// Well under the 30s sleep, so the check was killed rather than awaited
			expect(Date.now() - t0).toBeLessThan(10000);
		} finally {
			proc.kill("SIGKILL");
		}
	}, 45000);
});
