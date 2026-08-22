/**
 * The v2 task model and the record stream the engine emits.
 *
 * The surface syntax is deliberately provisional: it is decided from real config
 * ports, not up front. What is fixed here is the engine's contract.
 */

import type { WatchSpec } from "./watch.ts";

/** A task body. All three forms are peers, not escape hatches. */
export type Body =
	| string
	| string[]
	// biome-ignore lint/suspicious/noConfusingVoidType: a body returns an exit code or nothing, and undefined would reject a void-returning arrow
	| ((ctx: RunContext) => Promise<number | void> | number | void);

/** A precondition on the environment, checked before a body runs. */
export interface Requirement {
	tool?: string;
	env?: string;
	file?: string;
	hint?: string;
}

/** How a run responds to unmet requirements. `fail` is the default under CI. */
export type RequirementPolicy = "skip" | "warn" | "fail";

export interface Task {
	name: string;
	body: Body;
	/** Must succeed first, and is pulled into the run. */
	needs: string[];
	/** Ordering only, inert unless the target is already in the run. */
	after: string[];
	tags: string[];
	requires: Requirement[];
	cwd?: string;
	env?: Record<string, string>;
	/** Long-lived. Never a valid dependency of a non-persistent task. */
	persistent: boolean;
	/** Globs whose contents decide whether this task is already up to date. */
	inputs?: string[];
	/** Globs that must still exist for a cache hit to be honoured. */
	outputs?: string[];
	/** Restart this task when the watched files change. Persistent tasks only. */
	watch?: WatchSpec;
	/** Append the run's passthrough arguments to this task's command. */
	passthrough?: boolean;
	/**
	 * Serialize this task against every other tempo process in the project.
	 *
	 * `true` takes the project-wide lock; a string names the lock file, so tasks
	 * that contend for one tool's cache can share a lock without taking the rest.
	 */
	lock?: boolean | string;
	/**
	 * Stay in the run even when positional targets narrow it.
	 *
	 * For a check that covers the whole tree, so scoping to one component does
	 * not quietly drop the pass that covers everything.
	 */
	always?: boolean;
	/** Gates dependents on serving rather than on spawning. */
	readyWhen?: (ctx: RunContext) => Promise<boolean> | boolean;
	readyTimeoutMs?: number;
	readyPollMs?: number;
}

export interface Captured {
	stdout: string;
	stderr: string;
	code: number;
}

/**
 * What a function body is handed. These primitives exist so that logic which
 * would otherwise reach for a shell has somewhere better to go.
 */
export interface InvokeOptions {
	/** Resolved against the task's own directory. */
	cwd?: string;
	env?: Record<string, string>;
}

export interface RunContext {
	signal: AbortSignal;
	/** The directory this task runs in, resolved against the project root. */
	cwd: string;
	/** Passthrough arguments, empty unless the task declares `passthrough`. */
	args: string[];
	log(message: string): void;
	/** Run a command and collect its output, replacing `$(...)`. */
	capture(argv: string[] | string, opts?: InvokeOptions): Promise<Captured>;
	/** Run a command for its exit code. */
	run(argv: string[] | string, opts?: InvokeOptions): Promise<number>;
	/** Fail this task with a message rather than a stack trace. */
	fail(message: string): never;
}

/** Thrown by `ctx.fail` so a body can abort without an opaque error. */
export class TaskFailure extends Error {
	override readonly name = "TaskFailure";
}

/** A configuration error detected before anything runs. */
export class GraphError extends Error {
	override readonly name = "GraphError";
}

export type Outcome =
	| { kind: "ok"; code: 0; ms: number; waited?: number }
	| { kind: "cached"; ms: number }
	| { kind: "fail"; code: number; ms: number; waited?: number; error?: string }
	| { kind: "skip"; reason: string; missing: Requirement[] }
	| { kind: "blocked"; by: string }
	| { kind: "cancelled"; ms: number };

/**
 * The engine's only output. Renderers consume this stream; nothing renders by
 * writing directly, which is what keeps `--json` correct by construction.
 */
export type EngineEvent =
	| { type: "run-start"; ts: string; tasks: string[] }
	| { type: "task-start"; ts: string; task: string; persistent: boolean }
	| { type: "task-restart"; ts: string; task: string; reason: string }
	| { type: "task-ready"; ts: string; task: string; ms: number }
	| { type: "task-log"; ts: string; task: string; message: string }
	| {
			type: "task-output";
			ts: string;
			task: string;
			stream: "stdout" | "stderr";
			line: string;
	  }
	| { type: "task-settled"; ts: string; task: string; outcome: Outcome }
	| { type: "run-end"; ts: string; ok: boolean; ms: number };

export type EventSink = (event: EngineEvent) => void;
