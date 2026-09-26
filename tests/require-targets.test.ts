import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const FIXTURE_CONFIG = `import { defineConfig, task } from "@xevion/tempo";

export default defineConfig({
	tasks: [
		task({ name: "workspace:lint", body: "true", tags: ["check"], always: true }),
		task({ name: "bf4:lint", body: "true", tags: ["check", "fast"] }),
		task({ name: "bf4:test", body: "true", tags: ["check"] }),
		task({ name: "docs:format", body: "true", tags: ["check"] }),
	],
	commands: {
		check: {
			description: "test",
			tags: ["check"],
			requireTargets: true,
			example: "just check ctl bf4",
		},
		fmt: { description: "test", tasks: ["docs:format"] },
	},
});
`;

let dir = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tempo-require-targets-"));
	writeFileSync(join(dir, "tempo.config.ts"), FIXTURE_CONFIG);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function runCli(args: string[]): {
	status: number;
	stdout: string;
	stderr: string;
} {
	const result = spawnSync(
		"bun",
		["run", join(REPO_ROOT, "src", "cli.ts"), ...args],
		{
			cwd: dir,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, TEMPO_REEXEC: "1", NO_COLOR: "1" },
		},
	);
	return {
		status: result.status ?? 1,
		stdout: result.stdout?.toString() ?? "",
		stderr: result.stderr?.toString() ?? "",
	};
}

describe("requireTargets", () => {
	test("a bare invocation errors, lists scopes, and shows the example", () => {
		const { status, stderr } = runCli(["check"]);
		expect(status).toBe(1);
		expect(stderr).toContain('"check" needs at least one scope');
		// Full task names, so every listed entry is something a target can name.
		expect(stderr).toMatch(/bf4\s+bf4:lint, bf4:test/);
		expect(stderr).toMatch(/docs\s+docs:format/);
		// An all-always namespace is marked, not offered as a choice.
		expect(stderr).toMatch(/workspace\s+always runs/);
		expect(stderr).toContain("tags: fast");
		expect(stderr).toContain("example: just check ctl bf4");
	}, 15_000);

	test("naming a scope runs it, alongside always tasks", () => {
		const { status, stderr } = runCli(["check", "bf4", "--dry-run"]);
		expect(status).toBe(0);
		expect(stderr).toContain("bf4:lint");
		expect(stderr).toContain("workspace:lint");
		expect(stderr).not.toContain("docs:format");
	}, 15_000);

	test("a tag or a full task name is a target too", () => {
		const byTag = runCli(["check", "fast", "--dry-run"]);
		expect(byTag.status).toBe(0);
		expect(byTag.stderr).toContain("bf4:lint");
		expect(byTag.stderr).not.toContain("bf4:test");

		const byName = runCli(["check", "bf4:test", "--dry-run"]);
		expect(byName.status).toBe(0);
		expect(byName.stderr).toContain("bf4:test");
		expect(byName.stderr).not.toContain("bf4:lint");
	}, 15_000);

	test("a command without requireTargets is unaffected", () => {
		const { status, stderr } = runCli(["fmt", "--dry-run"]);
		expect(status).toBe(0);
		expect(stderr).toContain("docs:format");
	}, 15_000);

	test("requireTargets with passthrough is a config error", () => {
		writeFileSync(
			join(dir, "tempo.config.ts"),
			FIXTURE_CONFIG.replace(
				"requireTargets: true,",
				"requireTargets: true, passthrough: true,",
			),
		);
		const { status, stderr } = runCli(["check", "bf4"]);
		expect(status).toBe(1);
		expect(stderr).toContain("both requireTargets and passthrough");
	}, 15_000);
});

describe("unmatched targets", () => {
	test("a misspelled scope errors instead of running only always tasks", () => {
		const { status, stderr } = runCli(["check", "bf5"]);
		expect(status).toBe(1);
		expect(stderr).toContain('"check" has nothing matching "bf5"');
		expect(stderr).toContain("scopes:");
		expect(stderr).not.toContain("workspace:lint ok");
	}, 15_000);

	test("one bad target among good ones still errors, naming only it", () => {
		const { status, stderr } = runCli(["check", "bf4", "nope", "--dry-run"]);
		expect(status).toBe(1);
		expect(stderr).toContain('nothing matching "nope"');
		expect(stderr).not.toContain('"bf4"');
	}, 15_000);

	test("any command rejects a target outside its own selection", () => {
		const { status, stderr } = runCli(["fmt", "bf4"]);
		expect(status).toBe(1);
		expect(stderr).toContain('"fmt" has nothing matching "bf4"');
	}, 15_000);
});
