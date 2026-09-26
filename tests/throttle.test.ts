import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasTool } from "../src/engine/exec.ts";
import { Graph, task } from "../src/engine/graph.ts";
import { run } from "../src/engine/schedule.ts";
import {
	describeThrottle,
	parseCpuList,
	pickCpus,
	planThrottle,
	Throttle,
} from "../src/engine/throttle.ts";
import type { EngineEvent } from "../src/engine/types.ts";

// The wrappers are util-linux and the process listing is /proc.
const onLinux = process.platform === "linux";
const suite = onLinux ? describe : describe.skip;
const selfComm = onLinux
	? readFileSync("/proc/self/comm", "utf8").trim()
	: "never";

/** Run one task body, returning every line it wrote. */
async function outputOf(
	body: string | string[],
	opts: Parameters<typeof run>[2],
	env?: Record<string, string>,
): Promise<string[]> {
	const lines: string[] = [];
	const graph = new Graph([task({ name: "probe", tags: ["pick"], body, env })]);
	await run(graph, graph.selectByTag("pick"), {
		...opts,
		requirementPolicy: "warn",
		onEvent: (e: EngineEvent) => {
			if (e.type === "task-output") lines.push(e.line);
		},
	});
	return lines;
}

suite("planThrottle", () => {
	test("no spec is no plan", () => {
		expect(planThrottle(undefined)).toBeNull();
		expect(planThrottle(false)).toBeNull();
	});

	test("a name that is not running leaves the run alone", () => {
		expect(planThrottle({ whileRunning: "tempo-no-such-process" })).toBeNull();
	});

	test("a live name throttles, and records which one", () => {
		const plan = planThrottle({
			whileRunning: [selfComm, "tempo-no-such-process"],
		});
		expect(plan?.matched).toBe(selfComm);
		if (hasTool("chrt")) expect(plan?.prefix).toContain("chrt");
	});

	test("an unconditional spec applies with nothing running", () => {
		const plan = planThrottle({ cores: 1 });
		expect(plan).not.toBeNull();
		expect(plan?.matched).toBeUndefined();
	});

	test("cores on this machine resolve to a taskset list", () => {
		if (!hasTool("taskset")) return;
		const plan = planThrottle({ whileRunning: selfComm, cores: 1 });
		expect(plan?.prefix.slice(0, 2)).toEqual(["taskset", "-c"]);
		expect(plan?.cpus).toMatch(/^\d+(,\d+)*$/);
	});

	test("the description names what was given up", () => {
		const plan = planThrottle({ whileRunning: selfComm, concurrency: 2 });
		expect(plan).not.toBeNull();
		if (plan) expect(describeThrottle(plan)).toContain(selfComm);
	});
});

describe("cpu selection", () => {
	// Four cores with SMT siblings n and n+4, listed out of order.
	const smt = [
		[2, 6],
		[0, 4],
		[3, 7],
		[1, 5],
	];

	test("a kernel cpu list expands ranges and singles", () => {
		expect(parseCpuList("0-2,5,8-9\n")).toEqual([0, 1, 2, 5, 8, 9]);
		expect(parseCpuList("")).toEqual([]);
	});

	test("cores take both siblings of the last physical cores", () => {
		expect(pickCpus(smt, null, 2)).toEqual([2, 3, 6, 7]);
	});

	test("the whole machine is never handed over", () => {
		expect(pickCpus(smt, null, 99)).toEqual([1, 2, 3, 5, 6, 7]);
		expect(pickCpus([[0, 1]], null, 1)).toBeNull();
	});

	test("a cpuset restricts the choice to what the process may use", () => {
		// Only cores 0 and 1 are allowed: the last usable core is 1, not 3.
		expect(pickCpus(smt, new Set([0, 1, 4, 5]), 1)).toEqual([1, 5]);
		// One allowed core leaves nothing to yield to.
		expect(pickCpus(smt, new Set([0, 4]), 1)).toBeNull();
	});

	test("a half-allowed core contributes only its allowed thread", () => {
		expect(pickCpus(smt, new Set([0, 1, 5]), 1)).toEqual([1, 5]);
		expect(pickCpus(smt, new Set([0, 4, 1]), 1)).toEqual([1]);
	});
});

suite("re-planning", () => {
	/** A long-lived process whose comm is `name`, via a renamed shell. */
	async function probe(name: string): Promise<() => void> {
		const dir = mkdtempSync(join(tmpdir(), "tempo-throttle-"));
		const bin = join(dir, name);
		symlinkSync("/bin/sh", bin);
		// The trailing `:` stops the shell exec-ing sleep and losing its name.
		const child = spawn(bin, ["-c", "sleep 30; :"], { stdio: "ignore" });
		for (let i = 0; i < 100 && !planThrottle({ whileRunning: name }); i++) {
			await Bun.sleep(10);
		}
		return () => {
			child.kill("SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		};
	}

	test("a process starting and exiting mid-run moves the plan", async () => {
		const name = `tprobe${process.pid % 100000}`;
		const changes: (string | null)[] = [];
		const throttle = new Throttle(
			{ whileRunning: name },
			(plan) => changes.push(plan?.matched ?? null),
			0,
		);
		expect(throttle.initial).toBeNull();
		expect(throttle.current()).toBeNull();

		const stop = await probe(name);
		try {
			expect(throttle.current()?.matched).toBe(name);
		} finally {
			stop();
		}
		for (let i = 0; i < 100 && throttle.current() !== null; i++) {
			await Bun.sleep(10);
		}
		expect(throttle.current()).toBeNull();
		// Only transitions are reported, not every re-check.
		expect(changes).toEqual([name, null]);
	});

	test("the interval bounds how often /proc is scanned", () => {
		const throttle = new Throttle({ whileRunning: selfComm }, () => {}, 60_000);
		const first = throttle.current();
		expect(throttle.current()).toBe(first);
	});
});

suite("throttled runs", () => {
	test("concurrency is a cap, never a raise", async () => {
		const peaks = await Promise.all(
			[
				{ concurrency: 6, throttle: { concurrency: 2 } },
				{ concurrency: 2, throttle: { concurrency: 6 } },
			].map(async (opts) => {
				let active = 0;
				let peak = 0;
				const tasks = Array.from({ length: 6 }, (_, i) =>
					task({
						name: `t${i}`,
						tags: ["pick"],
						body: async () => {
							active++;
							peak = Math.max(peak, active);
							await Bun.sleep(25);
							active--;
						},
					}),
				);
				const graph = new Graph(tasks);
				await run(graph, graph.selectByTag("pick"), {
					...opts,
					requirementPolicy: "warn",
				});
				return peak;
			}),
		);
		// The second case is the one that proves a cap never raises: without it
		// the throttle's 6 would have overridden a run that asked for 2.
		for (const peak of peaks) expect(peak).toBeLessThanOrEqual(2);
	});

	test("a command body runs under the wrappers", async () => {
		if (!hasTool("chrt")) return;
		const lines = await outputOf(["sh", "-c", "chrt -p $$"], {
			throttle: { whileRunning: selfComm },
		});
		expect(lines.join("\n")).toContain("SCHED_IDLE");
	});

	test("throttle env sits under the task's own env", async () => {
		const inherited = await outputOf(
			["sh", "-c", "echo $TEMPO_THROTTLE_PROBE"],
			{
				throttle: {
					whileRunning: selfComm,
					env: { TEMPO_THROTTLE_PROBE: "plan" },
				},
			},
		);
		expect(inherited).toContain("plan");

		const overridden = await outputOf(
			["sh", "-c", "echo $TEMPO_THROTTLE_PROBE"],
			{
				throttle: {
					whileRunning: selfComm,
					env: { TEMPO_THROTTLE_PROBE: "plan" },
				},
			},
			{ TEMPO_THROTTLE_PROBE: "task" },
		);
		expect(overridden).toContain("task");
	});

	test("a task opting out spawns at normal priority", async () => {
		if (!hasTool("chrt")) return;
		const lines: string[] = [];
		const graph = new Graph([
			task({
				name: "server",
				tags: ["pick"],
				body: ["sh", "-c", "chrt -p $$"],
				throttle: false,
			}),
		]);
		await run(graph, graph.selectByTag("pick"), {
			throttle: { whileRunning: selfComm },
			requirementPolicy: "warn",
			onEvent: (e: EngineEvent) => {
				if (e.type === "task-output") lines.push(e.line);
			},
		});
		expect(lines.join("\n")).not.toContain("SCHED_IDLE");
	});

	test("a missing binary still fails as a spawn error", async () => {
		const graph = new Graph([
			task({ name: "ghost", tags: ["pick"], body: ["tempo-no-such-binary"] }),
		]);
		const { outcomes } = await run(graph, graph.selectByTag("pick"), {
			throttle: { whileRunning: selfComm },
			requirementPolicy: "warn",
		});
		const outcome = outcomes.get("ghost");
		expect(outcome?.kind).toBe("fail");
		// An error rather than a bare exit code means no wrapper stood in for it.
		if (outcome?.kind === "fail") {
			expect(outcome.error).toContain("tempo-no-such-binary");
		}
	});

	test("an opted-out run reports no plan", async () => {
		let announced: EngineEvent | null = null;
		const graph = new Graph([
			task({ name: "noop", tags: ["pick"], body: () => 0 }),
		]);
		await run(graph, graph.selectByTag("pick"), {
			throttle: false,
			requirementPolicy: "warn",
			onEvent: (e: EngineEvent) => {
				if (e.type === "run-start") announced = e;
			},
		});
		expect(announced).not.toBeNull();
		expect(
			(announced as unknown as { throttle?: unknown })?.throttle,
		).toBeUndefined();
	});
});
