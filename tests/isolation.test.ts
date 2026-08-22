import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Graph, task } from "../src/engine/graph.ts";
import { run } from "../src/engine/schedule.ts";
import type { EngineEvent } from "../src/engine/types.ts";
import { GraphError } from "../src/engine/types.ts";

let dir = "";
let entered = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tempo-iso-"));
	entered = process.cwd();
	mkdirSync(join(dir, "pkg"), { recursive: true });
	mkdirSync(join(dir, "deep", "nested"), { recursive: true });
});

afterEach(() => {
	process.chdir(entered);
	rmSync(dir, { recursive: true, force: true });
});

function lines(events: EngineEvent[], taskName: string): string[] {
	return events
		.filter((e) => e.type === "task-output" && e.task === taskName)
		.map((e) => (e as { line: string }).line);
}

describe("task working directory", () => {
	test("a task runs at the project root, not where tempo was invoked", async () => {
		// Invoking from a subdirectory must not change where anything runs.
		process.chdir(join(dir, "deep", "nested"));
		const events: EngineEvent[] = [];
		const graph = new Graph([
			task({ name: "where", body: "pwd", tags: ["x"] }),
		]);

		await run(graph, graph.selectByTag("x"), {
			rootDir: dir,
			requirementPolicy: "warn",
			onEvent: (e) => events.push(e),
		});
		expect(lines(events, "where")[0]).toBe(dir);
	});

	test("a relative cwd resolves against the project root", async () => {
		process.chdir(join(dir, "deep", "nested"));
		const events: EngineEvent[] = [];
		const graph = new Graph([
			task({ name: "where", body: "pwd", tags: ["x"], cwd: "pkg" }),
		]);

		await run(graph, graph.selectByTag("x"), {
			rootDir: dir,
			requirementPolicy: "warn",
			onEvent: (e) => events.push(e),
		});
		expect(lines(events, "where")[0]).toBe(join(dir, "pkg"));
	});

	test("a function body is handed the directory it runs in", async () => {
		process.chdir(entered);
		let seen = "";
		const graph = new Graph([
			task({
				name: "probe",
				tags: ["x"],
				cwd: "pkg",
				body: (ctx) => {
					seen = ctx.cwd;
				},
			}),
		]);
		await run(graph, graph.selectByTag("x"), {
			rootDir: dir,
			requirementPolicy: "warn",
		});
		expect(seen).toBe(join(dir, "pkg"));
	});
});

describe("file requirements", () => {
	test("a relative file requirement resolves against the project root", async () => {
		// `pkg` exists at the root but not under the invocation directory.
		process.chdir(join(dir, "deep", "nested"));
		const graph = new Graph([
			task({
				name: "needs-file",
				body: "true",
				tags: ["x"],
				requires: [{ file: "pkg" }],
			}),
		]);
		const { outcomes } = await run(graph, graph.selectByTag("x"), {
			rootDir: dir,
			requirementPolicy: "skip",
		});
		expect(outcomes.get("needs-file")?.kind).toBe("ok");
	});

	test("a genuinely missing file still skips", async () => {
		const graph = new Graph([
			task({
				name: "needs-file",
				body: "true",
				tags: ["x"],
				requires: [{ file: "absent" }],
			}),
		]);
		const { outcomes } = await run(graph, graph.selectByTag("x"), {
			rootDir: dir,
			requirementPolicy: "skip",
		});
		expect(outcomes.get("needs-file")?.kind).toBe("skip");
	});
});

describe("tempo's own directory", () => {
	test("everything under .tempo ignores itself", async () => {
		const graph = new Graph([
			task({ name: "l", body: "true", tags: ["x"], lock: true }),
		]);
		await run(graph, graph.selectByTag("x"), {
			rootDir: dir,
			requirementPolicy: "warn",
		});
		// A consumer never asked for this directory, so it must not reach their diff.
		expect(readFileSync(join(dir, ".tempo", ".gitignore"), "utf8").trim()).toBe(
			"*",
		);
	}, 30_000);
});

describe("locking", () => {
	function locked(name: string, lock: true | string = true) {
		return task({
			name,
			tags: ["x"],
			lock,
			body: [
				"sh",
				"-c",
				`echo "enter ${name}" >> trace.log; sleep 1; echo "leave ${name}" >> trace.log`,
			],
		});
	}

	function pairs(file: string): void {
		// Strict enter/leave pairing is what proves the critical section held.
		const trace = readFileSync(file, "utf8").split("\n").filter(Boolean);
		expect(trace.length % 2).toBe(0);
		for (let i = 0; i < trace.length; i += 2) {
			expect(trace[i + 1]).toBe(`leave ${trace[i]?.replace("enter ", "")}`);
		}
	}

	test("locked tasks never overlap, even running concurrently", async () => {
		const graph = new Graph([locked("one"), locked("two"), locked("three")]);
		const { ok } = await run(graph, graph.selectByTag("x"), {
			rootDir: dir,
			requirementPolicy: "warn",
			concurrency: 3,
		});
		expect(ok).toBe(true);
		const trace = join(dir, "trace.log");
		expect(
			readFileSync(trace, "utf8").split("\n").filter(Boolean),
		).toHaveLength(6);
		pairs(trace);
	}, 30_000);

	test("a function body takes the same lock as a command body", async () => {
		const fn = task({
			name: "fn",
			tags: ["x"],
			lock: true,
			body: async (ctx) => {
				appendFileSync(join(ctx.cwd, "trace.log"), "enter fn\n");
				await new Promise((r) => setTimeout(r, 500));
				appendFileSync(join(ctx.cwd, "trace.log"), "leave fn\n");
			},
		});
		const graph = new Graph([fn, locked("cmd")]);
		const { ok } = await run(graph, graph.selectByTag("x"), {
			rootDir: dir,
			requirementPolicy: "warn",
			concurrency: 2,
		});
		expect(ok).toBe(true);
		pairs(join(dir, "trace.log"));
	}, 30_000);

	test("the lock is released when its task finishes", async () => {
		const graph = new Graph([locked("only")]);
		await run(graph, graph.selectByTag("x"), {
			rootDir: dir,
			requirementPolicy: "warn",
		});
		expect(existsSync(join(dir, ".tempo", "locks", "project.lock"))).toBe(
			false,
		);
	}, 30_000);

	test("a lock path is taken literally, so separate locks stay separate", async () => {
		const graph = new Graph([locked("a", ".gradle/build.lock")]);
		const events: EngineEvent[] = [];
		await run(graph, graph.selectByTag("x"), {
			rootDir: dir,
			requirementPolicy: "warn",
			onEvent: (e) => events.push(e),
		});
		expect(existsSync(join(dir, ".gradle"))).toBe(true);
		expect(existsSync(join(dir, ".tempo", "locks", "project.lock"))).toBe(
			false,
		);
	});

	test("a lock left by a dead process is taken, not waited on", async () => {
		// A holder killed outright cannot clean up, so recovery is the only way out.
		const file = join(dir, ".tempo", "locks", "project.lock");
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify({
				pid: 0x7fffffff,
				host: hostname(),
				task: "ghost",
				since: new Date().toISOString(),
			}),
		);
		const graph = new Graph([locked("only")]);
		const began = performance.now();
		const { ok } = await run(graph, graph.selectByTag("x"), {
			rootDir: dir,
			requirementPolicy: "warn",
		});
		expect(ok).toBe(true);
		expect(performance.now() - began).toBeLessThan(5_000);
	}, 30_000);

	test("a lock held by a live process is waited on", async () => {
		const file = join(dir, ".tempo", "locks", "project.lock");
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify({
				pid: process.pid,
				host: hostname(),
				task: "live",
				since: new Date().toISOString(),
			}),
		);
		const controller = new AbortController();
		const events: EngineEvent[] = [];
		const graph = new Graph([locked("only")]);
		setTimeout(() => controller.abort(), 400);
		const { ok } = await run(graph, graph.selectByTag("x"), {
			rootDir: dir,
			requirementPolicy: "warn",
			signal: controller.signal,
			onEvent: (e) => events.push(e),
		});
		expect(ok).toBe(false);
		const logs = events
			.filter((e) => e.type === "task-log")
			.map((e) => (e as { message: string }).message);
		expect(logs.some((m) => m.includes("live"))).toBe(true);
	}, 30_000);

	test("a lock wait is reported beside the work, not added to it", async () => {
		const graph = new Graph([locked("one"), locked("two")]);
		const { outcomes } = await run(graph, graph.selectByTag("x"), {
			rootDir: dir,
			requirementPolicy: "warn",
			concurrency: 2,
		});
		const waiter = [...outcomes.values()].find(
			(o) => "waited" in o && o.waited !== undefined,
		);
		expect(waiter).toBeDefined();
		// Each body sleeps a second, so the second one waits about that long for the first.
		expect((waiter as { ms: number }).ms).toBeLessThan(1_800);
		expect((waiter as { waited: number }).waited).toBeGreaterThan(500);
	}, 30_000);

	test("two tempo processes exclude each other", async () => {
		// The single-process tests share a heap; only separate processes prove the file.
		const script = join(dir, "hold.mjs");
		writeFileSync(
			script,
			`import { acquireLock } from "${join(process.cwd(), "src", "engine", "lock.ts")}";
			import { appendFileSync } from "node:fs";
			const who = process.argv[2];
			using held = await acquireLock("${join(dir, ".tempo", "locks", "project.lock")}", { task: who });
			appendFileSync("${join(dir, "trace.log")}", "enter " + who + "\\n");
			await new Promise((r) => setTimeout(r, 600));
			appendFileSync("${join(dir, "trace.log")}", "leave " + who + "\\n");
			`,
		);
		const spawnHold = (who: string) =>
			new Promise<number>((resolveExit) => {
				const child = spawn("bun", [script, who], { stdio: "inherit" });
				child.on("exit", (code) => resolveExit(code ?? 1));
			});
		const codes = await Promise.all([spawnHold("one"), spawnHold("two")]);
		expect(codes).toEqual([0, 0]);
		pairs(join(dir, "trace.log"));
	}, 30_000);

	test("a persistent task cannot declare a lock", () => {
		expect(
			() =>
				new Graph([
					task({ name: "srv", body: "sleep 9", lock: true, persistent: true }),
				]),
		).toThrow(GraphError);
	});
});
