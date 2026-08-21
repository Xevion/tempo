import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Graph, task } from "../src/engine/graph.ts";
import { run } from "../src/engine/schedule.ts";
import type { EngineEvent, Outcome } from "../src/engine/types.ts";
import { watchPaths } from "../src/engine/watch.ts";

let dir = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tempo-dev-"));
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src", "in.txt"), "one");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 8000,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await Bun.sleep(25);
	}
	return false;
}

function lineCount(file: string): number {
	const full = join(dir, file);
	if (!existsSync(full)) return 0;
	return readFileSync(full, "utf8").split("\n").filter(Boolean).length;
}

function processMatching(pattern: string): boolean {
	const result = spawnSync("pgrep", ["-f", pattern], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	return (result.stdout?.toString() ?? "").trim().length > 0;
}

describe("watchPaths", () => {
	test("fires once for a burst of writes", async () => {
		using watcher = watchPaths(dir, { paths: ["src"], debounce: 60 });
		let fired = 0;
		void (async () => {
			for (;;) {
				await watcher.next();
				fired++;
			}
		})();

		await Bun.sleep(100);
		for (let i = 0; i < 5; i++) {
			writeFileSync(join(dir, "src", "in.txt"), `burst-${i}`);
			await Bun.sleep(5);
		}
		await waitFor(() => fired > 0);
		await Bun.sleep(200);
		expect(fired).toBe(1);
	});

	test("ignores files outside the extension filter", async () => {
		using watcher = watchPaths(dir, {
			paths: ["src"],
			exts: [".rs"],
			debounce: 40,
		});
		let fired = 0;
		void watcher.next().then(() => {
			fired++;
		});

		await Bun.sleep(100);
		writeFileSync(join(dir, "src", "in.txt"), "not rust");
		await Bun.sleep(300);
		expect(fired).toBe(0);

		writeFileSync(join(dir, "src", "lib.rs"), "fn main() {}");
		expect(await waitFor(() => fired === 1)).toBe(true);
	});
});

describe("dev supervision", () => {
	function serverTask(extra: Record<string, unknown> = {}) {
		return task({
			name: "server",
			tags: ["dev"],
			persistent: true,
			cwd: dir,
			body: ["sh", "-c", "echo up >> runs.log; exec sleep 44"],
			watch: { paths: ["src"], debounce: 50 },
			...extra,
		});
	}

	test("a watched process restarts when its inputs change", async () => {
		const graph = new Graph([serverTask()]);
		const controller = new AbortController();
		const done = run(graph, graph.selectByTag("dev"), {
			rootDir: dir,
			requirementPolicy: "warn",
			signal: controller.signal,
		});

		expect(await waitFor(() => lineCount("runs.log") === 1)).toBe(true);
		writeFileSync(join(dir, "src", "in.txt"), "changed");
		expect(await waitFor(() => lineCount("runs.log") === 2)).toBe(true);

		controller.abort();
		await done;
		await Bun.sleep(300);
		expect(processMatching("sleep 44")).toBe(false);
	}, 30_000);

	test("a restart emits a task-restart record", async () => {
		const events: EngineEvent[] = [];
		const graph = new Graph([serverTask()]);
		const controller = new AbortController();
		const done = run(graph, graph.selectByTag("dev"), {
			rootDir: dir,
			requirementPolicy: "warn",
			signal: controller.signal,
			onEvent: (e) => events.push(e),
		});

		expect(await waitFor(() => lineCount("runs.log") === 1)).toBe(true);
		writeFileSync(join(dir, "src", "in.txt"), "changed");
		expect(
			await waitFor(() => events.some((e) => e.type === "task-restart")),
		).toBe(true);

		controller.abort();
		await done;
	}, 30_000);

	test("interrupt rebuilds dependencies between restarts", async () => {
		const graph = new Graph([
			task({
				name: "build",
				cwd: dir,
				body: ["sh", "-c", "echo built >> build.log"],
			}),
			serverTask({
				needs: ["build"],
				watch: { paths: ["src"], debounce: 50, interrupt: true },
			}),
		]);
		const controller = new AbortController();
		const done = run(graph, graph.selectByTag("dev"), {
			rootDir: dir,
			requirementPolicy: "warn",
			signal: controller.signal,
		});

		expect(await waitFor(() => lineCount("runs.log") === 1)).toBe(true);
		expect(lineCount("build.log")).toBe(1);

		writeFileSync(join(dir, "src", "in.txt"), "changed");
		expect(await waitFor(() => lineCount("build.log") === 2)).toBe(true);
		expect(await waitFor(() => lineCount("runs.log") === 2)).toBe(true);

		controller.abort();
		await done;
	}, 30_000);

	test("a failed rebuild leaves the running process serving", async () => {
		// The build fails while `break` exists, so the restart must not happen.
		const graph = new Graph([
			task({
				name: "build",
				cwd: dir,
				body: ["sh", "-c", "test ! -f break && echo built >> build.log"],
			}),
			serverTask({ needs: ["build"] }),
		]);
		const controller = new AbortController();
		const done = run(graph, graph.selectByTag("dev"), {
			rootDir: dir,
			requirementPolicy: "warn",
			signal: controller.signal,
		});

		expect(await waitFor(() => lineCount("runs.log") === 1)).toBe(true);

		writeFileSync(join(dir, "break"), "");
		writeFileSync(join(dir, "src", "in.txt"), "changed");
		await Bun.sleep(1500);
		// Still the original process: a broken build must not cost a working server.
		expect(lineCount("runs.log")).toBe(1);

		rmSync(join(dir, "break"));
		writeFileSync(join(dir, "src", "in.txt"), "fixed");
		expect(await waitFor(() => lineCount("runs.log") === 2)).toBe(true);

		controller.abort();
		await done;
	}, 30_000);
});

describe("exit behaviour", () => {
	test("first-exits tears down the remaining processes", async () => {
		const graph = new Graph([
			task({
				name: "short",
				tags: ["dev"],
				persistent: true,
				cwd: dir,
				body: ["sh", "-c", "sleep 0.3"],
			}),
			task({
				name: "long",
				tags: ["dev"],
				persistent: true,
				cwd: dir,
				body: ["sh", "-c", "exec sleep 45"],
			}),
		]);

		const started = Date.now();
		const { outcomes } = await run(graph, graph.selectByTag("dev"), {
			rootDir: dir,
			requirementPolicy: "warn",
			exitBehavior: "first-exits",
		});

		expect(Date.now() - started).toBeLessThan(15_000);
		expect(outcomes.get("long")?.kind).toBe("cancelled");
		await Bun.sleep(300);
		expect(processMatching("sleep 45")).toBe(false);
	}, 30_000);
});

describe("passthrough", () => {
	test("arguments reach a task that opts in", async () => {
		const graph = new Graph([
			task({
				name: "echoer",
				tags: ["pick"],
				cwd: dir,
				body: ["sh", "-c", 'echo "$@" > args.log', "sh"],
				passthrough: true,
			}),
		]);

		await run(graph, graph.selectByTag("pick"), {
			rootDir: dir,
			requirementPolicy: "warn",
			passthrough: ["--port", "8080"],
		});
		expect(readFileSync(join(dir, "args.log"), "utf8").trim()).toBe(
			"--port 8080",
		);
	}, 15_000);

	test("a task without passthrough does not receive them", async () => {
		const graph = new Graph([
			task({
				name: "quiet",
				tags: ["pick"],
				cwd: dir,
				body: ["sh", "-c", 'echo "$@" > args.log', "sh"],
			}),
		]);

		await run(graph, graph.selectByTag("pick"), {
			rootDir: dir,
			requirementPolicy: "warn",
			passthrough: ["--port", "8080"],
		});
		expect(readFileSync(join(dir, "args.log"), "utf8").trim()).toBe("");
	}, 15_000);
});

function outcomeKind(outcomes: Map<string, Outcome>, name: string): string {
	return outcomes.get(name)?.kind ?? "missing";
}

describe("readiness with dev processes", () => {
	test("a dependent waits for the server to report ready", async () => {
		const graph = new Graph([
			task({
				name: "server",
				persistent: true,
				cwd: dir,
				body: ["sh", "-c", "sleep 0.4; touch ready; exec sleep 40"],
				readyWhen: () => existsSync(join(dir, "ready")),
				readyPollMs: 25,
			}),
			task({
				name: "client",
				tags: ["dev"],
				persistent: true,
				needs: ["server"],
				cwd: dir,
				body: ["sh", "-c", "test -f ready"],
			}),
		]);

		const controller = new AbortController();
		const done = run(graph, graph.selectByTag("dev"), {
			rootDir: dir,
			requirementPolicy: "warn",
			signal: controller.signal,
		});
		await Bun.sleep(2000);
		controller.abort();
		const { outcomes } = await done;

		// The client only passes because it ran after `ready` appeared.
		expect(outcomeKind(outcomes, "client")).toBe("ok");
	}, 30_000);
});
