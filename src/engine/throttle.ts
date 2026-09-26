import { readdirSync, readFileSync } from "node:fs";
import { hasTool } from "./exec.ts";

/** What a run gives up while something else needs the machine. */
export interface ThrottleSpec {
	/** Throttle only while a process with one of these names is alive. */
	whileRunning?: string | string[];
	/** Physical cores the run may use. Omitted leaves affinity alone. */
	cores?: number;
	/** Upper bound on concurrent tasks. Never raises a lower limit. */
	concurrency?: number;
	/** Environment for every task, under the task's own `env`. */
	env?: Record<string, string>;
}

/** A spec resolved against this machine: what every child is wrapped in. */
export interface ThrottlePlan {
	/** Prepended to each spawned argv. */
	prefix: string[];
	cpus?: string;
	concurrency?: number;
	env?: Record<string, string>;
	/** The live process that triggered it, absent when unconditional. */
	matched?: string;
}

const PROC = "/proc";
const CPU_DIR = "/sys/devices/system/cpu";
/** How long a resolved plan is trusted before `/proc` is scanned again. */
const REPLAN_MS = 1_000;

/**
 * The first of `names` with a live process, matched on `/proc/<pid>/comm`.
 *
 * `comm` is the executable name the kernel truncates to 15 characters, so a
 * longer name never matches.
 */
function liveProcess(names: string[]): string | null {
	const wanted = new Set(names);
	let entries: string[];
	try {
		entries = readdirSync(PROC);
	} catch {
		return null;
	}
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const comm = readFileSync(`${PROC}/${entry}/comm`, "utf8").trim();
			if (wanted.has(comm)) return comm;
		} catch {
			// exited between the listing and the read
		}
	}
	return null;
}

/** Expand a kernel CPU list such as `0-3,8,10-11`. */
export function parseCpuList(list: string): number[] {
	const cpus: number[] = [];
	for (const part of list.trim().split(",")) {
		const [lo, hi = lo] = part.split("-").map((n) => Number.parseInt(n, 10));
		if (lo === undefined || hi === undefined) continue;
		if (Number.isNaN(lo) || Number.isNaN(hi)) continue;
		for (let cpu = lo; cpu <= hi; cpu++) cpus.push(cpu);
	}
	return cpus;
}

/** Each physical core's hardware threads. An offline CPU has no topology and is skipped. */
function coreGroups(): number[][] {
	let names: string[];
	try {
		names = readdirSync(CPU_DIR).filter((name) => /^cpu\d+$/.test(name));
	} catch {
		return [];
	}
	const groups = new Map<string, number[]>();
	for (const name of names) {
		try {
			const list = readFileSync(
				`${CPU_DIR}/${name}/topology/thread_siblings_list`,
				"utf8",
			).trim();
			if (!groups.has(list)) groups.set(list, parseCpuList(list));
		} catch {
			// offline
		}
	}
	return [...groups.values()];
}

/** The CPUs a cpuset or affinity mask leaves this process, or null when unknown. */
function allowedCpus(): Set<number> | null {
	try {
		const status = readFileSync(`${PROC}/self/status`, "utf8");
		const list = /^Cpus_allowed_list:\s*(\S+)/m.exec(status)?.[1];
		return list ? new Set(parseCpuList(list)) : null;
	} catch {
		return null;
	}
}

/**
 * Every thread of the last `cores` physical cores this process may use.
 *
 * Whole cores, because a sibling thread shares execution units with the core
 * this run is yielding. The last ones, because the first carry the default IRQ
 * affinity. Never all of them, or there is nothing left to yield to.
 */
export function pickCpus(
	groups: number[][],
	allowed: Set<number> | null,
	cores: number,
): number[] | null {
	const usable = groups
		.map((group) => (allowed ? group.filter((cpu) => allowed.has(cpu)) : group))
		.filter((group) => group.length > 0)
		.sort((a, b) => Math.min(...a) - Math.min(...b));
	if (usable.length < 2) return null;
	const take = Math.min(Math.max(cores, 1), usable.length - 1);
	return usable
		.slice(-take)
		.flat()
		.sort((a, b) => a - b);
}

/** The wrapper chain, with whatever this machine actually has. */
function wrappers(cpus: string | null): string[] {
	const prefix: string[] = [];
	if (cpus !== null) prefix.push("taskset", "-c", cpus);
	// SCHED_IDLE rather than a nice value: an idle-class thread is skipped
	// outright whenever anything else on the core is runnable.
	if (hasTool("chrt")) prefix.push("chrt", "-i", "0");
	if (hasTool("ionice")) prefix.push("ionice", "-c3");
	return prefix;
}

/** Resolve a spec against this machine, or null when it does not apply. */
export function planThrottle(spec?: ThrottleSpec | false): ThrottlePlan | null {
	// taskset, chrt and ionice are util-linux, and /proc is where the answer is.
	if (!spec || process.platform !== "linux") return null;

	const names =
		spec.whileRunning === undefined ? [] : [spec.whileRunning].flat();
	const matched = names.length > 0 ? liveProcess(names) : null;
	if (names.length > 0 && matched === null) return null;

	const picked =
		spec.cores !== undefined && hasTool("taskset")
			? pickCpus(coreGroups(), allowedCpus(), spec.cores)
			: null;
	const cpus = picked === null ? null : picked.join(",");
	const plan: ThrottlePlan = { prefix: wrappers(cpus) };
	if (cpus !== null) plan.cpus = cpus;
	if (spec.concurrency !== undefined) plan.concurrency = spec.concurrency;
	if (spec.env !== undefined) plan.env = spec.env;
	if (matched !== null) plan.matched = matched;
	return plan;
}

/**
 * A spec kept current for the length of a run.
 *
 * A conditional spec is re-resolved at most once per interval, so a process
 * that starts or exits mid-session changes what the next spawn is wrapped in.
 */
export class Throttle {
	/** The plan as the run started, which fixes its concurrency cap. */
	readonly initial: ThrottlePlan | null;
	private plan: ThrottlePlan | null;
	private checkedAt: number;
	private readonly spec: ThrottleSpec | false | undefined;
	private readonly onChange: (plan: ThrottlePlan | null) => void;
	private readonly intervalMs: number;

	constructor(
		spec: ThrottleSpec | false | undefined,
		onChange: (plan: ThrottlePlan | null) => void = () => {},
		intervalMs = REPLAN_MS,
	) {
		this.spec = spec;
		this.onChange = onChange;
		this.intervalMs = intervalMs;
		this.initial = planThrottle(spec);
		this.plan = this.initial;
		this.checkedAt = Date.now();
	}

	/** The plan to wrap a spawn in right now. */
	current(): ThrottlePlan | null {
		// An unconditional spec cannot change under a run.
		if (!this.spec || this.spec.whileRunning === undefined) return this.plan;
		if (Date.now() - this.checkedAt < this.intervalMs) return this.plan;
		this.checkedAt = Date.now();
		const next = planThrottle(this.spec);
		if (JSON.stringify(next) !== JSON.stringify(this.plan)) {
			this.plan = next;
			this.onChange(next);
		}
		return this.plan;
	}
}

/** One line naming what the run gave up, for the renderer. */
export function describeThrottle(plan: ThrottlePlan): string {
	const parts: string[] = [];
	if (plan.cpus) parts.push(`cpus ${plan.cpus}`);
	if (plan.prefix.includes("chrt")) parts.push("idle class");
	if (plan.concurrency !== undefined)
		parts.push(`${plan.concurrency} at a time`);
	if (plan.env) parts.push(`env ${Object.keys(plan.env).join(", ")}`);
	const what = parts.length > 0 ? `: ${parts.join(", ")}` : "";
	const why = plan.matched ? ` (${plan.matched} is running)` : "";
	return `throttled${what}${why}`;
}
