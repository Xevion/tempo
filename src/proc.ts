import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { constants } from "node:os";
import type { Readable } from "node:stream";
import { TempoRunError } from "./errors.ts";
import { elapsed, exitCodeForSignal, RESET_TERMINAL } from "./fmt.ts";
import { lockArgv, noteLockWait } from "./lock.ts";
import { pipeJsonLines } from "./logging/json.ts";
import type { CollectResult, SignalStrategy } from "./types.ts";

// Re-export for backward compatibility with @xevion/tempo/proc consumers
export { TempoAbortError, TempoRunError } from "./errors.ts";
export { appendPassthrough, resolveCommandDef, resolveCwd } from "./resolve.ts";
export {
	checkMissingTools,
	collectRequires,
	getMissingTools,
	hasDockerDaemon,
	hasTool,
	requireDockerDaemon,
	warnMissingTool,
} from "./tools.ts";

/** Exit code for a command that could not be executed at all */
export const EXIT_SPAWN_FAILED = 127;

/** Conventional exit code for a signal-killed process (128 + signal number) */
export function exitCodeForKill(signal: NodeJS.Signals): number {
	const num = constants.signals[signal];
	return num === undefined ? 1 : 128 + num;
}

/** Promise that resolves with exit code when a ChildProcess exits or fails to spawn */
export function onExit(child: ChildProcess): Promise<number> {
	return new Promise((resolve) => {
		child.on("exit", (code, signal) =>
			resolve(code ?? (signal ? exitCodeForKill(signal) : 1)),
		);
		// Without an "error" listener a failed spawn throws an unhandled event and
		// leaves this promise pending forever.
		child.on("error", () => resolve(EXIT_SPAWN_FAILED));
	});
}

/** Collect all data from a readable stream into a string */
export function streamToString(
	stream: NodeJS.ReadableStream | null,
): Promise<string> {
	if (!stream) return Promise.resolve("");
	const chunks: Buffer[] = [];
	return new Promise((resolve) => {
		stream.on("data", (chunk: Buffer) => chunks.push(chunk));
		stream.on("end", () => resolve(Buffer.concat(chunks).toString()));
		stream.on("error", () => resolve(Buffer.concat(chunks).toString()));
	});
}

/** Default timeout for SIGTERM→SIGKILL escalation (milliseconds) */
export const GRACEFUL_KILL_TIMEOUT_MS = 3000;

/**
 * Children spawned into their own process group, so a signal can reach the
 * whole subtree rather than only the direct child.
 */
const detachedChildren = new WeakSet<ChildProcess>();

/**
 * Record that a child leads its own process group, so signals target the group.
 *
 * Detaching calls setsid, so the child keeps any inherited stdin but loses the
 * controlling terminal. Terminal-generated SIGINT therefore reaches only tempo,
 * which forwards it: one owner of termination rather than two racing.
 */
export function trackDetached(proc: ChildProcess): ChildProcess {
	detachedChildren.add(proc);
	return proc;
}

/** Signal a child, reaching its whole process group when it leads one. */
export function signalProc(proc: ChildProcess, signal: NodeJS.Signals): void {
	try {
		if (detachedChildren.has(proc) && proc.pid) process.kill(-proc.pid, signal);
		else proc.kill(signal);
	} catch {
		// already exited
	}
}

/**
 * Send SIGTERM to a process and schedule a SIGKILL fallback after `timeout` ms.
 * Returns a function to cancel the SIGKILL timer (call when the process exits cleanly).
 */
export function escalateKill(
	proc: ChildProcess,
	timeout = GRACEFUL_KILL_TIMEOUT_MS,
): () => void {
	signalProc(proc, "SIGTERM");
	const timer = setTimeout(() => signalProc(proc, "SIGKILL"), timeout);
	return () => clearTimeout(timer);
}

/**
 * Gracefully kill a process: SIGTERM → wait for exit → SIGKILL fallback if timeout exceeded.
 * The SIGKILL timer is cancelled if the process exits before the timeout.
 */
export async function gracefulKill(
	proc: ChildProcess,
	timeout = GRACEFUL_KILL_TIMEOUT_MS,
): Promise<void> {
	const cancel = escalateKill(proc, timeout);
	await onExit(proc);
	cancel();
}

/** Characters that mean a string genuinely needs a shell to interpret it. */
const SHELL_META = /[|&;<>()$`\\"'*?[\]~]/;
/** A leading `NAME=value` prefix is an env assignment, which only a shell applies. */
const ENV_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Operators that make a command a pipeline or list, which `exec` cannot replace. */
const SHELL_COMPOUND = /[|;&]/;

/**
 * Convert a command to spawn args.
 *
 * A string is split into argv and spawned directly unless it actually needs a
 * shell, so the spawned process is the command itself rather than an `sh` whose
 * death orphans its children. Where a shell is unavoidable, `exec` replaces it
 * for simple commands so no wrapper survives to swallow signals.
 */
export function resolveCmd(cmd: string | string[]): string[] {
	if (typeof cmd !== "string") return cmd;
	const trimmed = cmd.trim();
	if (trimmed === "") return ["sh", "-c", cmd];
	if (!SHELL_META.test(trimmed) && !ENV_PREFIX.test(trimmed)) {
		return trimmed.split(/\s+/);
	}
	return ["sh", "-c", SHELL_COMPOUND.test(trimmed) ? cmd : `exec ${cmd}`];
}

/** Wrap a synchronous command in its lock, announcing the wait when one is already held. */
function blockingLock(args: string[], lockFile?: string): string[] {
	if (!lockFile) return args;
	noteLockWait(lockFile);
	return lockArgv(lockFile, args);
}

export class ProcessGroup {
	private children: Set<ChildProcess> = new Set();
	private exitPromises: Map<ChildProcess, Promise<number>> = new Map();
	private externalPromises: Promise<number>[] = [];
	private cleanupFns: (() => void)[] = [];
	private asyncCleanupFns: (() => Promise<void>)[] = [];
	private strategy: SignalStrategy;
	private sigintHandler: (() => Promise<void>) | null = null;
	private sigtermHandler: (() => Promise<void>) | null = null;
	private onBeforeExitFn: (() => Promise<void>) | null = null;
	public shuttingDown = false;
	/** Signal that started the shutdown, so callers can report the right exit code */
	public signalReceived: NodeJS.Signals | null = null;

	private static cliSigintHandler: (() => void) | null = null;
	private static cliSigtermHandler: (() => void) | null = null;
	private static activeGroup: ProcessGroup | null = null;
	private static liveGroups: Set<ProcessGroup> = new Set();

	/** Register CLI-level fallback signal handlers that can be suppressed when a ProcessGroup takes ownership. */
	static registerCliSignalHandlers(
		handler: (signal: NodeJS.Signals) => Promise<void>,
	): () => void {
		const sigint = () => {
			handler("SIGINT");
		};
		const sigterm = () => {
			handler("SIGTERM");
		};
		ProcessGroup.cliSigintHandler = sigint;
		ProcessGroup.cliSigtermHandler = sigterm;
		process.on("SIGINT", sigint);
		process.on("SIGTERM", sigterm);
		return () => {
			if (ProcessGroup.cliSigintHandler) {
				process.removeListener("SIGINT", ProcessGroup.cliSigintHandler);
				ProcessGroup.cliSigintHandler = null;
			}
			if (ProcessGroup.cliSigtermHandler) {
				process.removeListener("SIGTERM", ProcessGroup.cliSigtermHandler);
				ProcessGroup.cliSigtermHandler = null;
			}
		};
	}

	constructor(options?: {
		signal?: SignalStrategy;
		onBeforeExit?: () => Promise<void>;
	}) {
		this.strategy = options?.signal ?? "natural";
		this.onBeforeExitFn = options?.onBeforeExit ?? null;
		ProcessGroup.liveGroups.add(this);
		this.suppressCliHandlers();
		this.setupSignalHandlers();
	}

	private suppressCliHandlers(): void {
		if (ProcessGroup.cliSigintHandler) {
			process.removeListener("SIGINT", ProcessGroup.cliSigintHandler);
		}
		if (ProcessGroup.cliSigtermHandler) {
			process.removeListener("SIGTERM", ProcessGroup.cliSigtermHandler);
		}
		ProcessGroup.activeGroup = this;
	}

	private restoreCliHandlers(): void {
		if (ProcessGroup.activeGroup !== this) return;
		ProcessGroup.activeGroup = null;
		if (ProcessGroup.cliSigintHandler) {
			process.on("SIGINT", ProcessGroup.cliSigintHandler);
		}
		if (ProcessGroup.cliSigtermHandler) {
			process.on("SIGTERM", ProcessGroup.cliSigtermHandler);
		}
	}

	private setupSignalHandlers(): void {
		const handler = async (signal: NodeJS.Signals) => {
			if (this.shuttingDown) {
				// A repeat signal means the graceful path is not converging: hard-kill
				// every live group (each holds its own children) and leave immediately.
				for (const group of ProcessGroup.liveGroups) group.killAllSync();
				process.exit(exitCodeForSignal(signal));
			}
			this.shuttingDown = true;
			this.signalReceived = signal;

			for (const fn of this.cleanupFns) {
				try {
					fn();
				} catch {
					// best-effort sync cleanup
				}
			}

			switch (this.strategy) {
				case "natural":
					await this.killAll();
					break;
				case "graceful":
					await this.killAll();
					await this.onBeforeExitFn?.();
					process.exit(exitCodeForSignal(signal));
					break;
				case "immediate":
					this.killAllSync();
					process.exit(exitCodeForSignal(signal));
					break;
			}
		};

		this.sigintHandler = () => handler("SIGINT");
		this.sigtermHandler = () => handler("SIGTERM");
		process.on("SIGINT", this.sigintHandler);
		process.on("SIGTERM", this.sigtermHandler);
	}

	/** Remove signal handlers to prevent leaks when this group is no longer needed */
	dispose(): void {
		ProcessGroup.liveGroups.delete(this);
		if (this.sigintHandler) {
			process.removeListener("SIGINT", this.sigintHandler);
			this.sigintHandler = null;
		}
		if (this.sigtermHandler) {
			process.removeListener("SIGTERM", this.sigtermHandler);
			this.sigtermHandler = null;
		}
		this.restoreCliHandlers();
	}

	spawn(
		cmd: string | string[],
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			inheritStdin?: boolean;
			ci?: boolean;
			/** Subsystem or process name, used as the label in JSON output envelopes */
			name?: string;
			/** When true, pipe stdout/stderr through JSON line envelopes instead of inheriting */
			json?: boolean;
		},
	): ChildProcess {
		const args = resolveCmd(cmd);
		const useJsonPipe = options?.json === true;
		const inheritStdin = options?.inheritStdin === true;
		const proc = spawn(args[0] as string, args.slice(1), {
			cwd: options?.cwd,
			env: { ...process.env, ...options?.env },
			stdio: [
				inheritStdin ? "inherit" : "ignore",
				useJsonPipe ? "pipe" : "inherit",
				useJsonPipe ? "pipe" : "inherit",
			],
			detached: true,
		});
		trackDetached(proc);
		if (useJsonPipe) {
			pipeJsonLines(proc, options?.name ?? "subprocess");
		}
		this.adopt(proc);
		return proc;
	}

	/**
	 * Track a child spawned elsewhere so killAll and the signal handlers cover it.
	 * Returns the exit promise, which callers should use instead of their own onExit.
	 */
	adopt(child: ChildProcess): Promise<number> {
		this.children.add(child);
		const exitPromise = onExit(child);
		this.exitPromises.set(child, exitPromise);
		exitPromise.then(() => {
			this.children.delete(child);
			this.exitPromises.delete(child);
		});
		return exitPromise;
	}

	onCleanup(fn: () => void): void {
		this.cleanupFns.push(fn);
	}

	onAsyncCleanup(fn: () => Promise<void>): void {
		this.asyncCleanupFns.push(fn);
	}

	/** Register an external lifetime promise (e.g. from BackendWatcher) so waitForFirst/waitForAll include it. */
	waitOn(promise: Promise<number>): void {
		this.externalPromises.push(promise);
	}

	async waitForFirst(): Promise<number> {
		const all = [...this.exitPromises.values(), ...this.externalPromises];
		if (all.length === 0) return 0;
		const exitCode = await Promise.race(all);
		await this.killAll();
		return exitCode;
	}

	async waitForAll(): Promise<number> {
		const all = [...this.exitPromises.values(), ...this.externalPromises];
		if (all.length === 0) return 0;
		const codes = await Promise.all(all);
		return Math.max(...codes);
	}

	private killAllRunning = false;

	async killAll(): Promise<void> {
		if (this.killAllRunning) return;
		this.killAllRunning = true;

		try {
			for (const fn of this.asyncCleanupFns) {
				try {
					await fn();
				} catch {
					// best-effort async cleanup
				}
			}
			this.asyncCleanupFns.length = 0;

			const cancels = [...this.children].map((child) => escalateKill(child));
			await Promise.all([...this.exitPromises.values()]);
			for (const cancel of cancels) cancel();
			this.children.clear();
			this.exitPromises.clear();

			ProcessGroup.resetTerminal();
		} finally {
			this.killAllRunning = false;
		}
	}

	private killAllSync(): void {
		for (const child of this.children) signalProc(child, "SIGKILL");
		this.children.clear();
		ProcessGroup.resetTerminal();
	}

	static resetTerminal(): void {
		// Terminal reset escape sequences are only meaningful for an interactive TTY.
		// Emit to stderr so they never corrupt a JSON Lines stdout stream.
		if (process.stderr.isTTY) {
			process.stderr.write(RESET_TERMINAL);
		}
		try {
			spawnSync("stty", ["sane"], { stdio: ["inherit", "pipe", "pipe"] });
		} catch {
			// stty may not be available
		}
		// Drain any pending terminal query responses (e.g. device attributes, cursor position)
		// that child processes requested before being killed — these arrive on stdin asynchronously
		// and would otherwise appear as garbled text in the shell prompt.
		ProcessGroup.drainStdin();
	}

	private static drainStdin(): void {
		if (!process.stdin.isTTY) return;
		try {
			// Consume any pending terminal query responses (device attributes, cursor position)
			// left in the input buffer by killed child processes. Uses a timed shell read
			// to drain bytes at the kernel level, which Node.js streams can't reliably do.
			spawnSync("bash", ["-c", "read -r -t 0.1 -s -n 1000 2>/dev/null; true"], {
				stdio: ["inherit", "pipe", "pipe"],
			});
		} catch {
			// best-effort
		}
	}
}

/** Synchronous execution with inherited stdio — throws TempoRunError on failure */
export function run(
	cmd: string | string[],
	options?: { cwd?: string; env?: Record<string, string>; lock?: string },
): void {
	const args = blockingLock(resolveCmd(cmd), options?.lock);
	const result = spawnSync(args[0] as string, args.slice(1), {
		cwd: options?.cwd,
		env: { ...process.env, ...options?.env },
		stdio: "inherit",
	});
	if (result.status !== 0) {
		throw new TempoRunError(result.status ?? 1);
	}
}

/** Synchronous execution with piped output */
export function runPiped(
	cmd: string | string[],
	options?: { cwd?: string; env?: Record<string, string>; lock?: string },
): { stdout: string; stderr: string; exitCode: number } {
	const args = blockingLock(resolveCmd(cmd), options?.lock);
	const result = spawnSync(args[0] as string, args.slice(1), {
		cwd: options?.cwd,
		env: { ...process.env, ...options?.env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		stdout: result.stdout?.toString() ?? "",
		stderr: result.stderr?.toString() ?? "",
		exitCode: result.status ?? 1,
	};
}

/** Interval between lock-wait notifications, and the delay before the first one */
const LOCK_WAIT_NOTICE_MS = 1000;

export interface LockOptions {
	/** Absolute path of the lockfile to hold for the command's lifetime */
	file: string;
	/** Called every second while still blocked, with the wait so far in milliseconds */
	onWait?: (waitedMs: number) => void;
	/** Called once the lock is held, with the total wait in milliseconds */
	onAcquire?: (waitedMs: number) => void;
}

/**
 * Wait for the locked command to signal acquisition on its ack pipe.
 * Resolves early if the process dies first, so a failed spawn never hangs the caller.
 */
function awaitLockAck(
	proc: ChildProcess,
	exitPromise: Promise<number>,
	lock: LockOptions,
): Promise<number> {
	const ack = proc.stdio[3] as Readable | null | undefined;
	if (!ack) return Promise.resolve(0);

	const start = Date.now();
	return new Promise<number>((resolve) => {
		let settled = false;
		const notice = setInterval(() => {
			lock.onWait?.(Date.now() - start);
		}, LOCK_WAIT_NOTICE_MS);
		const done = () => {
			if (settled) return;
			settled = true;
			clearInterval(notice);
			const waited = Date.now() - start;
			// Keep the pipe flowing but unread, so a command that writes to fd 3 never blocks.
			ack.removeAllListeners("data");
			ack.resume();
			lock.onAcquire?.(waited);
			resolve(waited);
		};
		ack.once("data", done);
		ack.once("end", done);
		ack.once("error", done);
		exitPromise.then(done);
	});
}

/** Grace period for a dead child's pipes to close before its output is given up on */
const STREAM_FLUSH_MS = 500;

/** Accumulate a stream into chunks, keeping partial data reachable if it never ends */
function collectStream(stream: Readable | null): {
	chunks: Buffer[];
	done: Promise<void>;
} {
	const chunks: Buffer[] = [];
	if (!stream) return { chunks, done: Promise.resolve() };
	const done = new Promise<void>((resolve) => {
		stream.on("data", (chunk: Buffer) => chunks.push(chunk));
		stream.on("end", () => resolve());
		stream.on("error", () => resolve());
	});
	return { chunks, done };
}

/**
 * Wait for both pipes to close, but only briefly. A grandchild inherits the pipes
 * and can hold them open long after the tracked child is dead.
 */
async function flushStreams(dones: Promise<void>[]): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const grace = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, STREAM_FLUSH_MS);
	});
	await Promise.race([Promise.all(dones), grace]);
	if (timer) clearTimeout(timer);
}

/** Result for a command that never started, so callers get a report instead of a crash */
function spawnFailure(name: string, err: unknown): CollectResult {
	const message = err instanceof Error ? err.message : String(err);
	return {
		name,
		stdout: "",
		stderr: `failed to run: ${message}\n`,
		exitCode: EXIT_SPAWN_FAILED,
		elapsed: "0.0",
	};
}

/** Async execution with piped output and timing. Timing starts once any lock is held. */
export async function spawnCollect(
	cmd: string | string[],
	options?: {
		cwd?: string;
		env?: Record<string, string>;
		name?: string;
		timeout?: number;
		lock?: LockOptions;
		/** Group that should track this child, so signals and killAll reach it */
		group?: ProcessGroup;
	},
): Promise<CollectResult> {
	const lock = options?.lock;
	const args = lock
		? lockArgv(lock.file, resolveCmd(cmd), { ack: true })
		: resolveCmd(cmd);
	const name = options?.name ?? args.join(" ");

	let proc: ChildProcess;
	try {
		proc = spawn(args[0] as string, args.slice(1), {
			cwd: options?.cwd,
			env: { ...process.env, ...options?.env },
			stdio: lock
				? ["ignore", "pipe", "pipe", "pipe"]
				: ["ignore", "pipe", "pipe"],
			detached: true,
		}) as ChildProcess;
		trackDetached(proc);
	} catch (err) {
		return spawnFailure(name, err);
	}

	let spawnError: Error | undefined;
	proc.on("error", (err) => {
		spawnError = err;
	});

	const exitPromise = options?.group ? options.group.adopt(proc) : onExit(proc);
	const outStream = collectStream(proc.stdout);
	const errStream = collectStream(proc.stderr);

	const waitedMs = lock ? await awaitLockAck(proc, exitPromise, lock) : 0;
	const startTime = Date.now();

	let timedOut = false;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	let cancelEscalation: (() => void) | undefined;

	if (options?.timeout) {
		killTimer = setTimeout(() => {
			timedOut = true;
			cancelEscalation = escalateKill(proc);
		}, options.timeout * 1000);
	}

	const exitCode = await exitPromise;
	if (killTimer) clearTimeout(killTimer);
	cancelEscalation?.();

	// A command that never started has no output to wait for.
	if (!spawnError) {
		await flushStreams([outStream.done, errStream.done]);
	}
	proc.stdout?.destroy();
	proc.stderr?.destroy();

	const stdout = Buffer.concat(outStream.chunks).toString();
	let stderr = Buffer.concat(errStream.chunks).toString();
	if (spawnError) {
		stderr = `failed to run: ${spawnError.message}\n${stderr}`;
	}
	if (timedOut) {
		stderr = `killed after ${options?.timeout}s timeout\n${stderr}`;
	}

	return {
		name,
		stdout,
		stderr,
		exitCode: timedOut ? 1 : exitCode,
		elapsed: elapsed(startTime),
		...(waitedMs >= 100 && { lockWait: (waitedMs / 1000).toFixed(1) }),
	};
}

/** Drain all promises, calling back as each completes */
export async function drainAsCompleted<
	T extends { name: string; stderr: string },
>(
	promises: Promise<T>[],
	fallbacks: T[],
	onResult: (result: T) => void | Promise<void>,
): Promise<void> {
	const remaining = new Map<Promise<T>, T>();
	for (let i = 0; i < promises.length; i++) {
		remaining.set(promises[i] as Promise<T>, fallbacks[i] as T);
	}

	while (remaining.size > 0) {
		const result = await Promise.race(
			[...remaining.keys()].map((p) =>
				p.then(
					(val) => ({ promise: p, val, ok: true as const }),
					(err) => {
						const fallback = remaining.get(p) as T;
						return {
							promise: p,
							val: {
								...fallback,
								stderr: String(err?.message ?? err ?? fallback.stderr),
							} as T,
							ok: false as const,
						};
					},
				),
			),
		);
		remaining.delete(result.promise);
		await onResult(result.val);
	}
}
