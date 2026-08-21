import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolveArgv } from "../src/engine/exec.ts";
import { Graph, task } from "../src/engine/graph.ts";
import { run } from "../src/engine/schedule.ts";
import {
	type EngineEvent,
	GraphError,
	type Outcome,
} from "../src/engine/types.ts";

function outcomeOf(outcomes: Map<string, Outcome>, name: string): Outcome {
	const found = outcomes.get(name);
	if (!found) throw new Error(`no outcome recorded for ${name}`);
	return found;
}

function processMatching(pattern: string): boolean {
	const result = spawnSync("pgrep", ["-f", pattern], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	return (result.stdout?.toString() ?? "").trim().length > 0;
}

describe("resolveArgv", () => {
	test("a plain command spawns directly, with no shell to swallow signals", () => {
		expect(resolveArgv("cargo run -p server")).toEqual({
			argv: ["cargo", "run", "-p", "server"],
			shell: false,
		});
	});

	test("an array is passed through untouched", () => {
		expect(resolveArgv(["go", "test", "./..."]).shell).toBe(false);
	});

	test("a simple command needing a shell is exec'd so no wrapper survives", () => {
		expect(resolveArgv("echo $HOME")).toEqual({
			argv: ["sh", "-c", "exec echo $HOME"],
			shell: true,
		});
	});

	test("a pipeline keeps its shell, since exec cannot replace a list", () => {
		expect(resolveArgv("a | b").argv).toEqual(["sh", "-c", "a | b"]);
	});

	test("a leading env assignment needs a shell to apply it", () => {
		expect(resolveArgv("FOO=1 cmd").argv[0]).toBe("sh");
	});
});

describe("graph validation", () => {
	test("an unknown dependency is rejected before anything runs", () => {
		expect(
			() => new Graph([task({ name: "a", body: "true", needs: ["ghost"] })]),
		).toThrow(GraphError);
	});

	test("duplicate task names are rejected", () => {
		expect(
			() =>
				new Graph([
					task({ name: "a", body: "true" }),
					task({ name: "a", body: "true" }),
				]),
		).toThrow(GraphError);
	});

	test("needing a persistent task is rejected as an undebuggable hang", () => {
		expect(
			() =>
				new Graph([
					task({ name: "server", body: "sleep 60", persistent: true }),
					task({ name: "test", body: "true", needs: ["server"] }),
				]),
		).toThrow(/persistent/);
	});

	test("a persistent task may need another persistent task", () => {
		expect(
			() =>
				new Graph([
					task({ name: "db", body: "sleep 60", persistent: true }),
					task({
						name: "api",
						body: "sleep 60",
						persistent: true,
						needs: ["db"],
					}),
				]),
		).not.toThrow();
	});

	test("a cycle is reported as its path, not a stack overflow", () => {
		const graph = new Graph([
			task({ name: "a", body: "true", needs: ["b"] }),
			task({ name: "b", body: "true", needs: ["a"] }),
		]);
		const cycle = graph.findCycle(new Set(["a", "b"]));
		expect(cycle).not.toBeNull();
		expect(cycle?.length).toBeGreaterThan(2);
	});
});

describe("selection", () => {
	const graph = new Graph([
		task({ name: "codegen", body: "true" }),
		task({ name: "lint", body: "true", tags: ["check"], needs: ["codegen"] }),
		task({ name: "types", body: "true", tags: ["check"] }),
		task({ name: "deploy", body: "true", tags: ["release"] }),
	]);

	test("selecting a tag pulls its needs transitively", () => {
		expect([...graph.selectByTag("check")].sort()).toEqual([
			"codegen",
			"lint",
			"types",
		]);
	});

	test("an unrelated tag is not pulled in", () => {
		expect(graph.selectByTag("check").has("deploy")).toBe(false);
	});

	test("layers place a dependency before its dependent", () => {
		const layers = graph.layers(graph.selectByTag("check"));
		expect(layers[0]).toContain("codegen");
		expect(layers.flat().indexOf("lint")).toBeGreaterThan(
			layers.flat().indexOf("codegen"),
		);
	});
});

describe("needs versus after", () => {
	test("after is inert when its target is not in the run set", async () => {
		const graph = new Graph([
			task({ name: "slow", body: "true" }),
			task({ name: "solo", body: "true", tags: ["pick"], after: ["slow"] }),
		]);
		const runSet = graph.selectByTag("pick");
		expect(runSet.has("slow")).toBe(false);

		const { outcomes, ok } = await run(graph, runSet, {
			requirementPolicy: "warn",
		});
		expect(ok).toBe(true);
		expect(outcomeOf(outcomes, "solo").kind).toBe("ok");
	});

	test("after orders without requiring success", async () => {
		const order: string[] = [];
		const graph = new Graph([
			task({
				name: "first",
				body: () => {
					order.push("first");
					return 1;
				},
				tags: ["pick"],
			}),
			task({
				name: "second",
				body: () => {
					order.push("second");
				},
				tags: ["pick"],
				after: ["first"],
			}),
		]);

		const { outcomes } = await run(graph, graph.selectByTag("pick"), {
			requirementPolicy: "warn",
		});
		expect(order).toEqual(["first", "second"]);
		// The failure does not block, because `after` carries no success requirement.
		expect(outcomeOf(outcomes, "second").kind).toBe("ok");
		expect(outcomeOf(outcomes, "first").kind).toBe("fail");
	});

	test("needs blocks the dependent when the dependency fails", async () => {
		let ran = false;
		const graph = new Graph([
			task({ name: "build", body: () => 1 }),
			task({
				name: "test",
				body: () => {
					ran = true;
				},
				tags: ["pick"],
				needs: ["build"],
			}),
		]);

		const { outcomes, ok } = await run(graph, graph.selectByTag("pick"), {
			requirementPolicy: "warn",
		});
		expect(ran).toBe(false);
		expect(ok).toBe(false);
		const blocked = outcomeOf(outcomes, "test");
		expect(blocked.kind).toBe("blocked");
		expect(blocked.kind === "blocked" && blocked.by).toBe("build");
	});

	test("a block propagates down a chain rather than hanging", async () => {
		const graph = new Graph([
			task({ name: "a", body: () => 1 }),
			task({ name: "b", body: "true", needs: ["a"] }),
			task({ name: "c", body: "true", tags: ["pick"], needs: ["b"] }),
		]);

		const { outcomes } = await run(graph, graph.selectByTag("pick"), {
			requirementPolicy: "warn",
		});
		expect(outcomeOf(outcomes, "b").kind).toBe("blocked");
		expect(outcomeOf(outcomes, "c").kind).toBe("blocked");
	});
});

describe("requirements", () => {
	const graph = new Graph([
		task({
			name: "needs-tool",
			body: "true",
			tags: ["pick"],
			requires: [{ tool: "definitely-not-a-real-binary-xyz" }],
		}),
	]);

	test("fail policy turns a missing tool into a failure, not a silent drop", async () => {
		const { outcomes, ok } = await run(graph, graph.selectByTag("pick"), {
			requirementPolicy: "fail",
		});
		expect(ok).toBe(false);
		expect(outcomeOf(outcomes, "needs-tool").kind).toBe("fail");
	});

	test("skip policy records a skip that is not a failure", async () => {
		const { outcomes, ok } = await run(graph, graph.selectByTag("pick"), {
			requirementPolicy: "skip",
		});
		expect(ok).toBe(true);
		expect(outcomeOf(outcomes, "needs-tool").kind).toBe("skip");
	});

	test("an env requirement reads the environment", async () => {
		const envGraph = new Graph([
			task({
				name: "deploy",
				body: "true",
				tags: ["pick"],
				requires: [{ env: "TEMPO_TEST_UNSET_VAR" }],
			}),
		]);
		const { outcomes } = await run(envGraph, envGraph.selectByTag("pick"), {
			requirementPolicy: "fail",
		});
		expect(outcomeOf(outcomes, "deploy").kind).toBe("fail");
	});
});

describe("function bodies", () => {
	test("capture returns output without a shell subshell", async () => {
		let captured = "";
		const graph = new Graph([
			task({
				name: "probe",
				tags: ["pick"],
				body: async (ctx) => {
					const result = await ctx.capture(["echo", "hello"]);
					captured = result.stdout.trim();
				},
			}),
		]);
		await run(graph, graph.selectByTag("pick"), { requirementPolicy: "warn" });
		expect(captured).toBe("hello");
	});

	test("fail produces a task failure with the given message", async () => {
		const messages: string[] = [];
		const graph = new Graph([
			task({
				name: "guard",
				tags: ["pick"],
				body: (ctx) => ctx.fail("no license file"),
			}),
		]);
		const { outcomes } = await run(graph, graph.selectByTag("pick"), {
			requirementPolicy: "warn",
			onEvent: (e: EngineEvent) => {
				if (e.type === "task-log") messages.push(e.message);
			},
		});
		expect(outcomeOf(outcomes, "guard").kind).toBe("fail");
		expect(messages).toContain("no license file");
	});

	test("a returned number is the exit code", async () => {
		const graph = new Graph([
			task({ name: "code", body: () => 3, tags: ["pick"] }),
		]);
		const { outcomes } = await run(graph, graph.selectByTag("pick"), {
			requirementPolicy: "warn",
		});
		const outcome = outcomeOf(outcomes, "code");
		expect(outcome.kind === "fail" && outcome.code).toBe(3);
	});
});

describe("persistent tasks", () => {
	test("readiness releases dependents without waiting for exit", async () => {
		let ready = false;
		setTimeout(() => {
			ready = true;
		}, 100);

		const graph = new Graph([
			task({
				name: "server",
				body: "sleep 5",
				persistent: true,
				readyWhen: () => ready,
				readyPollMs: 20,
			}),
			task({
				name: "client",
				body: "true",
				persistent: true,
				tags: ["pick"],
				needs: ["server"],
			}),
		]);

		const controller = new AbortController();
		const started = Date.now();
		let clientSettledMs: number | null = null;
		const promise = run(graph, graph.selectByTag("pick"), {
			requirementPolicy: "warn",
			signal: controller.signal,
			onEvent: (e) => {
				if (e.type === "task-settled" && e.task === "client") {
					clientSettledMs = Date.now() - started;
				}
			},
		});

		// The run stays alive for the persistent server; the client must not wait on it.
		while (clientSettledMs === null && Date.now() - started < 2000) {
			await Bun.sleep(20);
		}
		controller.abort();
		const { outcomes } = await promise;

		expect(outcomeOf(outcomes, "client").kind).toBe("ok");
		expect(clientSettledMs).not.toBeNull();
		expect(clientSettledMs ?? Number.POSITIVE_INFINITY).toBeLessThan(2000);
	});
});

describe("cancellation", () => {
	test("aborting kills grandchildren, not just the direct child", async () => {
		const marker = "tempo-orphan-probe-4711";
		const graph = new Graph([
			task({
				name: "parent",
				tags: ["pick"],
				// The sh is the child; the sleep it backgrounds is the grandchild.
				body: ["sh", "-c", `sleep 47 & echo ${marker}; wait`],
			}),
		]);

		const controller = new AbortController();
		const promise = run(graph, graph.selectByTag("pick"), {
			requirementPolicy: "warn",
			signal: controller.signal,
		});
		await Bun.sleep(300);
		expect(processMatching("sleep 47")).toBe(true);

		controller.abort();
		await promise;
		await Bun.sleep(300);

		expect(processMatching("sleep 47")).toBe(false);
	}, 15_000);

	test("a cancelled run reports cancelled rather than failed", async () => {
		const graph = new Graph([
			task({ name: "long", body: "sleep 20", tags: ["pick"] }),
		]);
		const controller = new AbortController();
		const promise = run(graph, graph.selectByTag("pick"), {
			requirementPolicy: "warn",
			signal: controller.signal,
		});
		await Bun.sleep(200);
		controller.abort();
		const { outcomes } = await promise;
		expect(outcomeOf(outcomes, "long").kind).toBe("cancelled");
	}, 15_000);
});

describe("event stream", () => {
	test("the run emits a start and end record around each task", async () => {
		const events: EngineEvent[] = [];
		const graph = new Graph([
			task({ name: "one", body: "true", tags: ["pick"] }),
		]);
		await run(graph, graph.selectByTag("pick"), {
			requirementPolicy: "warn",
			onEvent: (e) => events.push(e),
		});

		const types = events.map((e) => e.type);
		expect(types[0]).toBe("run-start");
		expect(types).toContain("task-start");
		expect(types).toContain("task-settled");
		expect(types.at(-1)).toBe("run-end");
	});

	test("child output is surfaced as records rather than inherited", async () => {
		const lines: string[] = [];
		const graph = new Graph([
			task({ name: "talk", body: ["echo", "from-child"], tags: ["pick"] }),
		]);
		await run(graph, graph.selectByTag("pick"), {
			requirementPolicy: "warn",
			onEvent: (e) => {
				if (e.type === "task-output") lines.push(e.line);
			},
		});
		expect(lines).toContain("from-child");
	});
});

describe("concurrency", () => {
	test("the limit caps simultaneous tasks", async () => {
		let active = 0;
		let peak = 0;
		const tasks = Array.from({ length: 6 }, (_, i) =>
			task({
				name: `t${i}`,
				tags: ["pick"],
				body: async () => {
					active++;
					peak = Math.max(peak, active);
					await Bun.sleep(50);
					active--;
				},
			}),
		);

		const graph = new Graph(tasks);
		await run(graph, graph.selectByTag("pick"), {
			concurrency: 2,
			requirementPolicy: "warn",
		});
		expect(peak).toBeLessThanOrEqual(2);
	});
});
