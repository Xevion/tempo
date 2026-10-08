import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FileIndex,
	fingerprint,
	globFiles,
	globToRegExp,
} from "../src/engine/cache.ts";
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

	test("an edited output forces a rebuild even when inputs match", async () => {
		const graph = buildGraph();
		const opts = { rootDir: dir, requirementPolicy: "warn" as const };

		await run(graph, graph.selectByTag("pick"), opts);
		// Editing a generated file by hand must not survive as a cache hit.
		writeFileSync(join(dir, "out.txt"), "hand written");

		const again = await run(graph, graph.selectByTag("pick"), opts);
		expect(outcomeOf(again.outcomes, "build").kind).toBe("ok");
		expect(readFileSync(join(dir, "out.txt"), "utf8")).toBe("one");
	});

	test("a same-size edit to an output still forces a rebuild", async () => {
		const graph = buildGraph();
		const opts = { rootDir: dir, requirementPolicy: "warn" as const };

		await run(graph, graph.selectByTag("pick"), opts);
		const out = join(dir, "out.txt");
		writeFileSync(out, "two");
		// Pin a distinct mtime so the test never depends on timestamp granularity.
		const later = new Date(Date.now() + 60_000);
		utimesSync(out, later, later);

		const again = await run(graph, graph.selectByTag("pick"), opts);
		expect(outcomeOf(again.outcomes, "build").kind).toBe("ok");
		expect(readFileSync(out, "utf8")).toBe("one");
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

const hasGit = spawnSync("git", ["--version"]).status === 0;
const gitSuite = hasGit ? describe : describe.skip;

function put(path: string, body = "x"): void {
	mkdirSync(join(dir, path, ".."), { recursive: true });
	writeFileSync(join(dir, path), body);
}

gitSuite("inside a git work tree", () => {
	beforeEach(() => {
		spawnSync("git", ["init", "-q"], { cwd: dir });
		put(".gitignore", "target/\ndist/\nsecret.env\n");
		put("src/a.ts");
		put("target/debug/big.ts");
		put("dist/out.mjs", "built");
		put("secret.env", "KEY=1");
	});

	test("ignored trees are never listed", () => {
		put("src/new.ts");
		expect(globFiles(dir, ["**/*.ts"])).toEqual(["src/a.ts", "src/new.ts"]);
	});

	test("a nested repository is walked rather than dropped", () => {
		put("vendor/lib/inner.ts", "one");
		spawnSync("git", ["init", "-q"], { cwd: join(dir, "vendor", "lib") });
		expect(globFiles(dir, ["vendor/**"])).toEqual(["vendor/lib/inner.ts"]);

		const t = task({ name: "t", body: "true", inputs: ["vendor/**"] });
		const before = fingerprint(t, dir);
		put("vendor/lib/inner.ts", "two");
		expect(fingerprint(t, dir)).not.toBe(before);
	});

	test("an ignored file named outright is still an input", () => {
		expect(globFiles(dir, ["secret.env", "src/*.ts"])).toEqual([
			"secret.env",
			"src/a.ts",
		]);
	});

	test("a file deleted but still in the index is not an input", () => {
		spawnSync("git", ["add", "src/a.ts"], { cwd: dir });
		rmSync(join(dir, "src", "a.ts"));
		const index = new FileIndex(dir);
		expect(index.files()).toContain("src/a.ts");
		expect(index.digest("src/a.ts")).toBeNull();
		const t = task({ name: "t", body: "true", inputs: ["src/*.ts"] });
		const before = fingerprint(t, dir);
		put("src/a.ts");
		expect(fingerprint(t, dir)).not.toBe(before);
	});

	test("changing an ignored file leaves the fingerprint alone", () => {
		const t = task({ name: "t", body: "true", inputs: ["**/*.ts"] });
		const before = fingerprint(t, dir);
		put("target/debug/big.ts", "changed");
		expect(fingerprint(t, dir)).toBe(before);
		put("src/a.ts", "changed");
		expect(fingerprint(t, dir)).not.toBe(before);
	});

	test("an ignored output is still checked", async () => {
		const graph = new Graph([
			task({
				name: "build",
				tags: ["pick"],
				body: ["sh", "-c", "echo built > dist/out.mjs"],
				cwd: dir,
				inputs: ["src/*.ts"],
				outputs: ["dist/**/*.mjs"],
			}),
		]);
		const opts = { rootDir: dir, requirementPolicy: "warn" as const };
		await run(graph, graph.selectByTag("pick"), opts);
		const hit = await run(graph, graph.selectByTag("pick"), opts);
		expect(outcomeOf(hit.outcomes, "build").kind).toBe("cached");

		rmSync(join(dir, "dist", "out.mjs"));
		const again = await run(graph, graph.selectByTag("pick"), opts);
		expect(outcomeOf(again.outcomes, "build").kind).toBe("ok");
	});

	test("an edit that keeps size and mtime is still seen", () => {
		const file = join(dir, "src", "a.ts");
		const past = new Date(Date.now() - 60_000);
		writeFileSync(file, "aaaa");
		utimesSync(file, past, past);
		// A negative window treats a file written a moment ago as long settled.
		const first = new FileIndex(dir, -1_000);
		const digest = first.digest("src/a.ts");
		first.flush();

		// Same size, same mtime: only ctime gives the edit away.
		writeFileSync(file, "bbbb");
		utimesSync(file, past, past);
		expect(new FileIndex(dir, -1_000).digest("src/a.ts")).not.toBe(digest);
	});

	test("an untouched file is not read again", () => {
		const file = join(dir, "src", "a.ts");
		const past = new Date(Date.now() - 60_000);
		writeFileSync(file, "aaaa");
		utimesSync(file, past, past);
		const first = new FileIndex(dir, -1_000);
		const digest = first.digest("src/a.ts");
		first.flush();

		// Swap the stored digest for a marker: a file matching its stat is never re-read.
		const stored = join(dir, ".tempo", "hashes.json");
		writeFileSync(
			stored,
			readFileSync(stored, "utf8").replace(digest ?? "", "marker"),
		);
		expect(new FileIndex(dir, -1_000).digest("src/a.ts")).toBe("marker");
	});
});

describe("cache keys", () => {
	test("a key is part of the fingerprint, and a function is evaluated each time", () => {
		const plain = task({ name: "t", body: "true" });
		let version = "1";
		const keyed = task({ name: "t", body: "true", cacheKey: () => version });
		const first = fingerprint(keyed, dir);
		expect(first).not.toBe(fingerprint(plain, dir));
		version = "2";
		expect(fingerprint(keyed, dir)).not.toBe(first);
		expect(
			fingerprint(task({ name: "t", body: "true", cacheKey: "2" }), dir),
		).not.toBe(first);
	});
});
