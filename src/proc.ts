import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { TempoRunError } from "./errors.ts";
import { elapsed, exitCodeForSignal, RESET_TERMINAL } from "./fmt.ts";
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

/** Promise that resolves with exit code when a ChildProcess exits */
export function onExit(child: ChildProcess): Promise<number> {
	return new Promise((resolve) => {
		child.on("exit", (code) => resolve(code ?? 1));
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
 * Send SIGTERM to a process and schedule a SIGKILL fallback after `timeout` ms.
 * Returns a function to cancel the SIGKILL timer (call when the process exits cleanly).
 */
export function escalateKill(
	proc: ChildProcess,
	timeout = GRACEFUL_KILL_TIMEOUT_MS,
): () => void {
	try {
		proc.kill("SIGTERM");
	} catch {
		// already exited
	}
	const timer = setTimeout(() => {
		try {
			proc.kill("SIGKILL");
		} catch {
			// already exited
		}
	}, timeout);
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

/** Convert a command to spawn args. Strings run via sh -c, arrays exec directly. */
export function resolveCmd(cmd: string | string[]): string[] {
	return typeof cmd === "string" ? ["sh", "-c", cmd] : cmd;
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

	private static cliSigintHandler: (() => void) | null = null;
	private static cliSigtermHandler: (() => void) | null = null;
	private static activeGroup: ProcessGroup | null = null;

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
			if (this.shuttingDown) return;
			this.shuttingDown = true;

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
		const proc = spawn(args[0] as string, args.slice(1), {
			cwd: options?.cwd,
			env: { ...process.env, ...options?.env },
			stdio: [
				options?.inheritStdin ? "inherit" : "ignore",
				useJsonPipe ? "pipe" : "inherit",
				useJsonPipe ? "pipe" : "inherit",
			],
		});
		if (useJsonPipe) {
			pipeJsonLines(proc, options?.name ?? "subprocess");
		}
		this.children.add(proc);
		const exitPromise = onExit(proc);
		this.exitPromises.set(proc, exitPromise);
		exitPromise.then(() => {
			this.children.delete(proc);
			this.exitPromises.delete(proc);
		});
		return proc;
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
		for (const child of this.children) {
			try {
				child.kill("SIGKILL");
			} catch {
				// already exited
			}
		}
		this.children.clear();
		ProcessGroup.resetTerminal();
	}

	static resetTerminal(): void {
		process.stdout.write(RESET_TERMINAL);
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
	options?: { cwd?: string; env?: Record<string, string> },
): void {
	const args = resolveCmd(cmd);
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
	options?: { cwd?: string; env?: Record<string, string> },
): { stdout: string; stderr: string; exitCode: number } {
	const args = resolveCmd(cmd);
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

/** Async execution with piped output and timing */
export async function spawnCollect(
	cmd: string | string[],
	startTime: number,
	options?: {
		cwd?: string;
		env?: Record<string, string>;
		name?: string;
		timeout?: number;
	},
): Promise<CollectResult> {
	const args = resolveCmd(cmd);
	const proc = spawn(args[0] as string, args.slice(1), {
		cwd: options?.cwd,
		env: { ...process.env, ...options?.env },
		stdio: ["ignore", "pipe", "pipe"],
	}) as ChildProcess;

	let timedOut = false;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	let cancelEscalation: (() => void) | undefined;

	if (options?.timeout) {
		killTimer = setTimeout(() => {
			timedOut = true;
			cancelEscalation = escalateKill(proc);
		}, options.timeout * 1000);
	}

	const [exitCode, stdout, stderrRaw] = await Promise.all([
		onExit(proc),
		streamToString(proc.stdout),
		streamToString(proc.stderr),
	]);
	if (killTimer) clearTimeout(killTimer);
	cancelEscalation?.();

	let stderr = stderrRaw;
	if (timedOut) {
		stderr = `killed after ${options?.timeout}s timeout\n${stderr}`;
	}

	return {
		name: options?.name ?? args.join(" "),
		stdout,
		stderr,
		exitCode: timedOut ? 1 : exitCode,
		elapsed: elapsed(startTime),
	};
}

/** Drain all promises, calling back as each completes */
export async function drainAsCompleted<
	T extends { name: string; stderr: string },
>(
	promises: Promise<T>[],
	fallbacks: T[],
	onResult: (result: T) => void,
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
		onResult(result.val);
	}
}
