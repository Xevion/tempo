import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globFiles, globToRegExp } from "../src/engine/cache.ts";
import { Graph, task } from "../src/engine/graph.ts";
import { run } from "../src/engine/schedule.ts";
import type { Outcome } from "../src/engine/types.ts";

let dir = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tempo-cache-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function outcomeOf(outcomes: Map<string, Outcome>, name: string): Outcome {
	const found = outcomes.get(name);
	if (!found) throw new Error(`no outcome for ${name}`);
	return found;
}

describe("globToRegExp", () => {
	test("**/ spans any number of directories, including none", () => {
		const re = globToRegExp("src/**/*.ts");
		expect(re.test("src/a.ts")).toBe(true);
		expect(re.test("src/deep/nested/a.ts")).toBe(true);
		expect(re.test("other/a.ts")).toBe(false);
	});

	test("* stops at a separator", () => {
		const re = globToRegExp("src/*.ts");
		expect(re.test("src/a.ts")).toBe(true);
		expect(re.test("src/deep/a.ts")).toBe(false);
	});

	test("braces expand to alternatives", () => {
		const re = globToRegExp("dist/*.{mjs,d.ts}");
		expect(re.test("dist/index.mjs")).toBe(true);
		expect(re.test("dist/index.d.ts")).toBe(true);
		expect(re.test("dist/index.js")).toBe(false);
	});

	test("a dot is literal, not any-character", () => {
		expect(globToRegExp("a.ts").test("axts")).toBe(false);
	});
});

describe("globFiles", () => {
	test("walks recursively and skips pruned directories", () => {
		mkdirSync(join(dir, "src", "deep"), { recursive: true });
		mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(dir, "src", "a.ts"), "a");
		writeFileSync(join(dir, "src", "deep", "b.ts"), "b");
		writeFileSync(join(dir, "node_modules", "pkg", "c.ts"), "c");

		expect(globFiles(dir, ["**/*.ts"])).toEqual(["src/a.ts", "src/deep/b.ts"]);
	});
});

describe("task caching", () => {
	function buildGraph(): Graph {
		return new Graph([
			task({
				name: "build",
				tags: ["pick"],
				body: ["sh", "-c", "cat src/in.txt > out.txt"],
				cwd: dir,
				inputs: ["src/*.txt"],
				outputs: ["out.txt"],
			}),
		]);
	}

	beforeEach(() => {
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "in.txt"), "one");
	});

	test("the first run executes and the second is cached", async () => {
		const graph = buildGraph();
		const opts = { rootDir: dir, requirementPolicy: "warn" as const };

		const first = await run(graph, graph.selectByTag("pick"), opts);
		expect(outcomeOf(first.outcomes, "build").kind).toBe("ok");

		const second = await run(graph, graph.selectByTag("pick"), opts);
		expect(outcomeOf(second.outcomes, "build").kind).toBe("cached");
		expect(second.ok).toBe(true);
	});

	test("changing an input invalidates the fingerprint", async () => {
		const graph = buildGraph();
		const opts = { rootDir: dir, requirementPolicy: "warn" as const };

		await run(graph, graph.selectByTag("pick"), opts);
		writeFileSync(join(dir, "src", "in.txt"), "two");

		const again = await run(graph, graph.selectByTag("pick"), opts);
		expect(outcomeOf(again.outcomes, "build").kind).toBe("ok");
	});

	test("rewriting an input with identical content stays a hit", async () => {
		const graph = buildGraph();
		const opts = { rootDir: dir, requirementPolicy: "warn" as const };

		await run(graph, graph.selectByTag("pick"), opts);
		// Same bytes, new mtime: content hashing must not treat this as a change.
		writeFileSync(join(dir, "src", "in.txt"), "one");

		const again = await run(graph, graph.selectByTag("pick"), opts);
		expect(outcomeOf(again.outcomes, "build").kind).toBe("cached");
	});

	test("a deleted output forces a rebuild even when inputs match", async () => {
		const graph = buildGraph();
		const opts = { rootDir: dir, requirementPolicy: "warn" as const };

		await run(graph, graph.selectByTag("pick"), opts);
		rmSync(join(dir, "out.txt"));

		const again = await run(graph, graph.selectByTag("pick"), opts);
		expect(outcomeOf(again.outcomes, "build").kind).toBe("ok");
	});

	test("cache: false recomputes regardless of the fingerprint", async () => {
		const graph = buildGraph();
		const opts = { rootDir: dir, requirementPolicy: "warn" as const };

		await run(graph, graph.selectByTag("pick"), opts);
		const forced = await run(graph, graph.selectByTag("pick"), {
			...opts,
			cache: false,
		});
		expect(outcomeOf(forced.outcomes, "build").kind).toBe("ok");
	});

	test("a failing task is not fingerprinted, so it reruns", async () => {
		const graph = new Graph([
			task({
				name: "bad",
				tags: ["pick"],
				body: ["sh", "-c", "exit 3"],
				cwd: dir,
				inputs: ["src/*.txt"],
			}),
		]);
		const opts = { rootDir: dir, requirementPolicy: "warn" as const };

		const first = await run(graph, graph.selectByTag("pick"), opts);
		expect(outcomeOf(first.outcomes, "bad").kind).toBe("fail");

		const second = await run(graph, graph.selectByTag("pick"), opts);
		expect(outcomeOf(second.outcomes, "bad").kind).toBe("fail");
	});

	test("a cache hit still releases dependents", async () => {
		let dependentRan = false;
		const graph = new Graph([
			task({
				name: "build",
				body: ["sh", "-c", "cat src/in.txt > out.txt"],
				cwd: dir,
				inputs: ["src/*.txt"],
				outputs: ["out.txt"],
			}),
			task({
				name: "consume",
				tags: ["pick"],
				needs: ["build"],
				body: () => {
					dependentRan = true;
				},
			}),
		]);
		const opts = { rootDir: dir, requirementPolicy: "warn" as const };

		await run(graph, graph.selectByTag("pick"), opts);
		dependentRan = false;

		const second = await run(graph, graph.selectByTag("pick"), opts);
		expect(outcomeOf(second.outcomes, "build").kind).toBe("cached");
		expect(dependentRan).toBe(true);
	});

	test("a task with no declared inputs never caches", async () => {
		const graph = new Graph([
			task({ name: "always", tags: ["pick"], body: "true", cwd: dir }),
		]);
		const opts = { rootDir: dir, requirementPolicy: "warn" as const };

		await run(graph, graph.selectByTag("pick"), opts);
		const second = await run(graph, graph.selectByTag("pick"), opts);
		expect(outcomeOf(second.outcomes, "always").kind).toBe("ok");
	});
});
