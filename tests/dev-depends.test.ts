import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Regression: an unsatisfiable `dependsOn` graph must fail loudly. Mutually
// waiting spawn tasks used to drain the event loop and exit 0 having started
// nothing, and an unknown dependency used to resolve instantly.
const REPO_ROOT = resolve(import.meta.dir, "..");
const CLI = resolve(REPO_ROOT, "src/cli.ts");
const INDEX = resolve(REPO_ROOT, "src/index.ts");

const dirs: string[] = [];

/** Write a project whose two dev processes append to `marker`, and return both paths. */
function writeProject(
	slug: string,
	deps: { a: string[]; b: string[] },
): { dir: string; marker: string } {
	const dir = mkdtempSync(join(tmpdir(), `tempo-${slug}-`));
	dirs.push(dir);
	const marker = join(dir, "spawned.log");
	const proc = (name: string, dependsOn: string[]) =>
		`{ type: "unmanaged", dependsOn: ${JSON.stringify(dependsOn)}, cmd: ${JSON.stringify(`echo ${name} >> ${marker}`)} }`;

	writeFileSync(
		join(dir, "tempo.config.ts"),
		`import { defineConfig, runners } from ${JSON.stringify(INDEX)};

export default defineConfig({
	subsystems: {
		a: { commands: { lint: "true" } },
		b: { commands: { lint: "true" } },
	},
	dev: {
		exitBehavior: "all-exit",
		processes: {
			a: ${proc("a", deps.a)},
			b: ${proc("b", deps.b)},
		},
	},
	commands: {
		dev: runners.dev(),
	},
});
`,
	);
	return { dir, marker };
}

function runDev(dir: string, args: string[] = []) {
	const result = spawnSync("bun", ["run", CLI, "dev", ...args], {
		cwd: dir,
		env: { ...process.env, CI: "", FORCE_COLOR: "0", NO_COLOR: "1" },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 20_000,
	});
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("dev process dependsOn validation", () => {
	test("a dependency cycle fails loudly instead of exiting 0", () => {
		const { dir, marker } = writeProject("dev-cycle", {
			a: ["b"],
			b: ["a"],
		});

		const { status, output } = runDev(dir);

		expect(status).not.toBe(0);
		expect(output).toContain("cycle");
		expect(output).toMatch(/a -> b -> a|b -> a -> b/);
		expect(existsSync(marker)).toBe(false);
	});

	test("an unknown dependency name fails instead of resolving instantly", () => {
		const { dir, marker } = writeProject("dev-typo", { a: ["bb"], b: [] });

		const { status, output } = runDev(dir);

		expect(status).not.toBe(0);
		expect(output).toContain("not a configured dev process");
		expect(existsSync(marker)).toBe(false);
	});

	test("a dependency outside the current targets is allowed", () => {
		const { dir, marker } = writeProject("dev-untargeted", {
			a: ["b"],
			b: [],
		});

		const { status } = runDev(dir, ["a"]);

		expect(status).toBe(0);
		expect(existsSync(marker)).toBe(true);
	});
});
