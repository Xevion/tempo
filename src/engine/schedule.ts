import {
	fingerprint,
	isCacheable,
	isFresh,
	writeFingerprint,
} from "./cache.ts";
import {
	captureCommand,
	describeRequirement,
	exitCode,
	missingRequirements,
	resolveArgv,
	Spawned,
} from "./exec.ts";
import type { Graph } from "./graph.ts";
import { supervise } from "./supervise.ts";
import {
	type EngineEvent,
	type EventSink,
	GraphError,
	type Outcome,
	type RequirementPolicy,
	type RunContext,
	type Task,
	TaskFailure,
} from "./types.ts";

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_READY_POLL_MS = 250;

export interface RunOptions {
	concurrency?: number;
	signal?: AbortSignal;
	onEvent?: EventSink;
	requirementPolicy?: RequirementPolicy;
	/** Root for resolving input and output globs, and for the cache directory. */
	rootDir?: string;
	/** Set false to recompute every task regardless of its fingerprint. */
	cache?: boolean;
	/** Arguments appended to any task declaring `passthrough`. */
	passthrough?: string[];
	/** first-exits tears the run down as soon as any persistent task exits. */
	exitBehavior?: "first-exits" | "all-exit";
	/** Ask children for colour. Defaults to whether stderr is a terminal. */
	color?: boolean;
}

export interface RunResult {
	outcomes: Map<string, Outcome>;
	ok: boolean;
	ms: number;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(): string {
	return new Date().toISOString();
}

/** Limits concurrent work. Persistent tasks are supervisors and never counted. */
class Semaphore {
	private active = 0;
	private readonly waiting: (() => void)[] = [];
	private readonly limit: number;

	constructor(limit: number) {
		this.limit = limit;
	}

	async acquire(): Promise<() => void> {
		if (this.active >= this.limit) {
			await new Promise<void>((resolve) => this.waiting.push(resolve));
		}
		this.active++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
			this.waiting.shift()?.();
		};
	}
}

function defaultPolicy(): RequirementPolicy {
	return process.env.CI ? "fail" : "warn";
}

/** Map an exit code to an outcome, preserving cancellation. */
function codeOutcome(code: number, aborted: boolean, ms: number): Outcome {
	if (aborted && code !== 0) return { kind: "cancelled", ms };
	return code === 0 ? { kind: "ok", code: 0, ms } : { kind: "fail", code, ms };
}

function errorOutcome(err: unknown, aborted: boolean, ms: number): Outcome {
	if (aborted) return { kind: "cancelled", ms };
	return {
		kind: "fail",
		code: 1,
		ms,
		error: err instanceof Error ? err.message : String(err),
	};
}

export function planLayers(
	graph: Graph,
	runSet: ReadonlySet<string>,
): string[][] {
	return graph.layers(runSet);
}

/**
 * Execute a run set.
 *
 * Each task exposes one gate promise. `needs` awaits it and requires success;
 * `after` awaits it and ignores the result. For a persistent task the gate opens
 * on readiness rather than on exit, so dependents are released without waiting
 * for a process that never returns.
 */
export async function run(
	graph: Graph,
	runSet: ReadonlySet<string>,
	opts: RunOptions = {},
): Promise<RunResult> {
	const cycle = graph.findCycle(runSet);
	if (cycle) {
		throw new GraphError(`dependency cycle: ${cycle.join(" -> ")}`);
	}

	const policy = opts.requirementPolicy ?? defaultPolicy();
	const rootDir = opts.rootDir ?? process.cwd();
	const cacheEnabled = opts.cache !== false;
	const passthrough = opts.passthrough ?? [];
	const exitBehavior = opts.exitBehavior ?? "all-exit";
	const color = opts.color ?? process.stderr.isTTY ?? false;
	const semaphore = new Semaphore(opts.concurrency ?? DEFAULT_CONCURRENCY);
	const edgesByTask = graph.edgesWithin(runSet);
	const outcomes = new Map<string, Outcome>();
	const gates = new Map<string, Deferred<boolean>>();
	for (const name of runSet) gates.set(name, deferred<boolean>());

	const controller = new AbortController();
	const abort = () => controller.abort();
	if (opts.signal?.aborted) abort();
	else opts.signal?.addEventListener("abort", abort, { once: true });

	const startedAt = performance.now();
	const emit = (event: EngineEvent): void => opts.onEvent?.(event);

	const settle = (name: string, outcome: Outcome, opened: boolean): void => {
		if (!outcomes.has(name)) {
			outcomes.set(name, outcome);
			emit({ type: "task-settled", ts: nowIso(), task: name, outcome });
		}
		gates.get(name)?.resolve(opened);
	};

	/** Await incoming edges, returning the hard dependency that did not open. */
	const awaitDependencies = async (t: Task): Promise<string | null> => {
		const hard = new Set(t.needs.filter((d) => runSet.has(d)));
		for (const dep of edgesByTask.get(t.name) ?? []) {
			const opened = await (gates.get(dep)?.promise ?? Promise.resolve(true));
			if (!opened && hard.has(dep)) return dep;
		}
		return null;
	};

	/** The outcome dictated by unmet requirements, or null to proceed. */
	const requirementOutcome = (t: Task): Outcome | null => {
		const missing = missingRequirements(t.requires);
		if (missing.length === 0) return null;
		const described = missing.map(describeRequirement).join(", ");
		if (policy === "warn") {
			emit({
				type: "task-log",
				ts: nowIso(),
				task: t.name,
				message: `missing ${described}`,
			});
			return null;
		}
		return policy === "skip"
			? { kind: "skip", reason: `missing ${described}`, missing }
			: { kind: "fail", code: 1, ms: 0, error: `missing ${described}` };
	};

	/** Re-run one dependency, honouring its cache. False means it failed. */
	const rebuildOne = async (
		dep: string,
		sig: AbortSignal,
	): Promise<boolean> => {
		const d = graph.get(dep);
		emit({ type: "task-start", ts: nowIso(), task: dep, persistent: false });

		let stamp: string | null = null;
		if (cacheEnabled && isCacheable(d)) {
			stamp = fingerprint(d, rootDir);
			if (isFresh(d, rootDir, stamp)) {
				emit({
					type: "task-settled",
					ts: nowIso(),
					task: dep,
					outcome: { kind: "cached", ms: 0 },
				});
				return true;
			}
		}

		const began = performance.now();
		const code = await runBody(d, sig, emit, undefined, passthrough, color);
		const outcome = codeOutcome(code, sig.aborted, performance.now() - began);
		if (outcome.kind === "ok" && stamp) writeFingerprint(rootDir, dep, stamp);
		emit({ type: "task-settled", ts: nowIso(), task: dep, outcome });
		return outcome.kind === "ok";
	};

	/** Re-run a watched task's dependencies in dependency order. */
	const rebuildDeps = async (t: Task, sig: AbortSignal): Promise<boolean> => {
		const order = graph
			.layers(runSet)
			.flat()
			.filter((n) => t.needs.includes(n));
		for (const dep of order) {
			if (!(await rebuildOne(dep, sig))) return false;
		}
		return true;
	};

	/** Watched tasks run under a supervisor; everything else runs once. */
	const runSupervised = (t: Task, sig: AbortSignal): Promise<number> => {
		if (!t.watch || !t.persistent) {
			return runBody(t, sig, emit, gates.get(t.name), passthrough, color);
		}
		return supervise(t, sig, {
			rootDir,
			emit,
			runBody: (s2) =>
				runBody(t, s2, emit, gates.get(t.name), passthrough, color),
			rebuild: (s2) => rebuildDeps(t, s2),
		});
	};

	const executeBody = async (t: Task, stamp: string | null): Promise<void> => {
		const release = t.persistent ? () => {} : await semaphore.acquire();
		const began = performance.now();
		emit({
			type: "task-start",
			ts: nowIso(),
			task: t.name,
			persistent: t.persistent,
		});
		try {
			const code = await runSupervised(t, controller.signal);
			const outcome = codeOutcome(
				code,
				controller.signal.aborted,
				performance.now() - began,
			);
			// Only a clean success is worth remembering.
			if (outcome.kind === "ok" && stamp) {
				writeFingerprint(rootDir, t.name, stamp);
			}
			settle(t.name, outcome, outcome.kind === "ok");
			// A dev session ends when its first long-lived process does.
			if (t.persistent && exitBehavior === "first-exits") controller.abort();
		} catch (err) {
			const ms = performance.now() - began;
			settle(t.name, errorOutcome(err, controller.signal.aborted, ms), false);
		} finally {
			release();
		}
	};

	const execute = async (t: Task): Promise<void> => {
		const blocker = await awaitDependencies(t);
		if (blocker !== null) {
			settle(t.name, { kind: "blocked", by: blocker }, false);
			return;
		}
		if (controller.signal.aborted) {
			settle(t.name, { kind: "cancelled", ms: 0 }, false);
			return;
		}
		const blockedByRequirement = requirementOutcome(t);
		if (blockedByRequirement) {
			settle(t.name, blockedByRequirement, false);
			return;
		}

		// A cache hit is a success for dependents: the outputs are already there.
		let stamp: string | null = null;
		if (cacheEnabled && isCacheable(t)) {
			stamp = fingerprint(t, rootDir);
			if (isFresh(t, rootDir, stamp)) {
				settle(t.name, { kind: "cached", ms: 0 }, true);
				return;
			}
		}
		await executeBody(t, stamp);
	};

	emit({ type: "run-start", ts: nowIso(), tasks: [...runSet].sort() });

	try {
		await Promise.all([...runSet].map((name) => execute(graph.get(name))));
	} finally {
		opts.signal?.removeEventListener("abort", abort);
		// Release anything still gated so no dependent is left awaiting forever.
		for (const [name, gate] of gates) {
			if (!outcomes.has(name)) {
				outcomes.set(name, { kind: "cancelled", ms: 0 });
			}
			gate.resolve(false);
		}
	}

	const ms = performance.now() - startedAt;
	const ok = [...outcomes.values()].every(
		(o) => o.kind === "ok" || o.kind === "cached" || o.kind === "skip",
	);
	emit({ type: "run-end", ts: nowIso(), ok, ms });
	return { outcomes, ok, ms };
}

function buildContext(
	t: Task,
	signal: AbortSignal,
	emit: (event: EngineEvent) => void,
	color = false,
): RunContext {
	return {
		signal,
		log: (message) =>
			emit({ type: "task-log", ts: nowIso(), task: t.name, message }),
		capture: (argv) => captureCommand(argv, { cwd: t.cwd, env: t.env, signal }),
		run: async (argv) => {
			const { argv: resolved } = resolveArgv(argv);
			await using proc = new Spawned(resolved, {
				cwd: t.cwd,
				env: t.env,
				signal,
				color,
				onLine: (stream, line) =>
					emit({
						type: "task-output",
						ts: nowIso(),
						task: t.name,
						stream,
						line,
					}),
			});
			return exitCode(await proc.exited);
		},
		fail: (message) => {
			throw new TaskFailure(message);
		},
	};
}

/** Poll a readiness probe, opening the task's gate as soon as it passes. */
async function awaitReady(
	t: Task,
	ctx: RunContext,
	emit: (event: EngineEvent) => void,
	gate: Deferred<boolean> | undefined,
	began: number,
): Promise<void> {
	const timeout = t.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const poll = t.readyPollMs ?? DEFAULT_READY_POLL_MS;
	const deadline = Date.now() + timeout;

	while (Date.now() < deadline) {
		if (ctx.signal.aborted) return;
		const ready = await Promise.resolve(t.readyWhen?.(ctx)).catch(() => false);
		if (ready) {
			emit({
				type: "task-ready",
				ts: nowIso(),
				task: t.name,
				ms: performance.now() - began,
			});
			gate?.resolve(true);
			return;
		}
		await sleep(poll);
	}
	emit({
		type: "task-log",
		ts: nowIso(),
		task: t.name,
		message: `readiness probe timed out after ${timeout}ms`,
	});
	gate?.resolve(false);
}

/** Open a persistent task's gate, immediately or once its probe passes. */
function armReadiness(
	t: Task,
	ctx: RunContext,
	emit: (event: EngineEvent) => void,
	gate: Deferred<boolean> | undefined,
	began: number,
): void {
	if (t.readyWhen) {
		void awaitReady(t, ctx, emit, gate, began);
		return;
	}
	emit({ type: "task-ready", ts: nowIso(), task: t.name, ms: 0 });
	gate?.resolve(true);
}

async function runFunctionBody(
	body: Extract<Task["body"], (...args: never[]) => unknown>,
	ctx: RunContext,
): Promise<number> {
	try {
		const result = await body(ctx);
		return typeof result === "number" ? result : 0;
	} catch (err) {
		if (err instanceof TaskFailure) {
			ctx.log(err.message);
			return 1;
		}
		throw err;
	}
}

async function runBody(
	t: Task,
	signal: AbortSignal,
	emit: (event: EngineEvent) => void,
	gate: Deferred<boolean> | undefined,
	passthrough: string[] = [],
	color = false,
): Promise<number> {
	const ctx = buildContext(t, signal, emit, color);
	const began = performance.now();

	// A persistent task releases dependents on readiness, not on exit.
	if (t.persistent) armReadiness(t, ctx, emit, gate, began);

	if (typeof t.body === "function") return runFunctionBody(t.body, ctx);

	const { argv } = resolveArgv(t.body);
	const full = t.passthrough ? [...argv, ...passthrough] : argv;
	await using proc = new Spawned(full, {
		cwd: t.cwd,
		env: t.env,
		signal,
		color,
		onLine: (stream, line) =>
			emit({ type: "task-output", ts: nowIso(), task: t.name, stream, line }),
	});
	return exitCode(await proc.exited);
}
