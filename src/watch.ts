import { type ChildProcess, spawn } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import { elapsed } from "./fmt.ts";
import { pipeJsonLines } from "./logging/json.ts";
import {
	EXIT_SPAWN_FAILED,
	escalateKill,
	onExit,
	resolveCmd,
	signalProc,
	streamToString,
	trackDetached,
} from "./proc.ts";

const logger = getLogger(["tempo", "watch"]);

type WatcherState =
	| "building"
	| "idle"
	| "running"
	| "building_with_server"
	| "swapping";

/** A child paired with the exit promise captured at spawn, so a later waiter cannot miss the exit event. */
interface Tracked {
	proc: ChildProcess;
	exit: Promise<number>;
}

/** A build command in flight, plus whatever it managed to say on its way out. */
interface BuildRun {
	/** Null when the command could not be spawned at all. */
	tracked: Tracked | null;
	stdout: Promise<string>;
	stderr: Promise<string>;
	/** Filled in when the command could not be exec'd, synchronously or via "error". */
	spawnError: { message: string };
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function track(proc: ChildProcess): Tracked {
	return { proc, exit: onExit(proc) };
}

/** Grace period for a finished build's pipes to close before its output is given up on. */
const OUTPUT_FLUSH_MS = 500;

/**
 * Read a build's captured output, preferring stderr. A command that could not be
 * exec'd leaves its pipes open forever, so the wait is bounded rather than infinite.
 */
async function readOutput(
	stdoutPromise: Promise<string>,
	stderrPromise: Promise<string>,
): Promise<string> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const grace = new Promise<[string, string]>((r) => {
		timer = setTimeout(() => r(["", ""]), OUTPUT_FLUSH_MS);
	});
	const [stdout, stderr] = await Promise.race([
		Promise.all([stdoutPromise, stderrPromise]),
		grace,
	]);
	if (timer) clearTimeout(timer);
	return (stderr || stdout).trimEnd();
}

export class BackendWatcher {
	private state: WatcherState = "building";
	private server: Tracked | null = null;
	private buildProc: Tracked | null = null;
	private watchers: FSWatcher[] = [];
	private dirty = false;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private resolveDone!: (code: number) => void;
	/** Bumped by every build; an invocation whose generation is stale must not touch shared state. */
	private generation = 0;
	private stopped = false;

	/** Resolves when the watcher shuts down (signal, fatal error, or explicit shutdown). */
	readonly done: Promise<number>;

	private watchDirs: string[];
	private watchExts: Set<string>;
	private extraPaths: string[];
	private buildCmd: string[];
	private runCmd: string[];
	private debounceMs: number;
	private interrupt: boolean;
	private verboseBuild: boolean;
	private cwd?: string;
	private env?: Record<string, string>;
	private passthrough: string[];
	private json: boolean;
	private name: string;

	constructor(options: {
		watchDirs: string[];
		watchExts: string[];
		extraPaths?: string[];
		buildCmd: string | string[];
		runCmd: string | string[];
		debounce?: number;
		interrupt?: boolean;
		verboseBuild?: boolean;
		cwd?: string;
		env?: Record<string, string>;
		passthrough?: string[];
		/** When true, pipe server stdout/stderr through JSON line envelopes */
		json?: boolean;
		/** Label for JSON output envelopes (typically the subsystem name) */
		name?: string;
	}) {
		this.done = new Promise((resolve) => {
			this.resolveDone = resolve;
		});
		this.watchDirs = options.watchDirs;
		this.watchExts = new Set(options.watchExts);
		this.extraPaths = options.extraPaths ?? [];
		this.buildCmd = resolveCmd(options.buildCmd);
		this.runCmd = resolveCmd(options.runCmd);
		this.debounceMs = options.debounce ?? 200;
		this.interrupt = options.interrupt ?? true;
		this.verboseBuild = options.verboseBuild ?? false;
		this.cwd = options.cwd;
		this.env = options.env;
		this.passthrough = options.passthrough ?? [];
		this.json = options.json ?? false;
		this.name = options.name ?? "managed";
	}

	start(): void {
		this.setupWatchers();
		this.startBuild();
	}

	private setupWatchers(): void {
		for (const dir of this.watchDirs) {
			const fullDir = this.cwd ? join(this.cwd, dir) : dir;
			try {
				const watcher = watch(
					fullDir,
					{ recursive: true },
					(_event, filename) => {
						if (!filename) return;
						const ext = `.${filename.split(".").pop()}`;
						if (this.watchExts.has(ext)) {
							this.onFileChange();
						}
					},
				);
				this.watchers.push(watcher);
			} catch {
				// directory may not exist yet
			}
		}

		for (const extraPath of this.extraPaths) {
			const fullPath = this.cwd ? join(this.cwd, extraPath) : extraPath;
			try {
				const watcher = watch(fullPath, () => this.onFileChange());
				this.watchers.push(watcher);
			} catch {
				// file may not exist
			}
		}
	}

	private onFileChange(): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => this.handleChange(), this.debounceMs);
	}

	private handleChange(): void {
		if (this.stopped) return;
		switch (this.state) {
			case "building":
			case "building_with_server":
				if (this.interrupt && this.buildProc) {
					signalProc(this.buildProc.proc, "SIGTERM");
					this.startBuild();
				} else {
					this.dirty = true;
				}
				break;
			case "idle":
			case "running":
				this.state = this.server ? "building_with_server" : "building";
				this.startBuild();
				break;
			case "swapping":
				this.dirty = true;
				break;
		}
	}

	/** Fire-and-forget entry point; the build drives the state machine from here. */
	private startBuild(): void {
		this.build().catch((err) => {
			logger.error("build step crashed: {message}", {
				message: errorMessage(err),
			});
			this.state = this.server ? "running" : "idle";
		});
	}

	/** Spawn the build command, capturing an exec failure instead of letting it escape. */
	private spawnBuild(): BuildRun {
		const spawnError = { message: "" };
		const empty = Promise.resolve("");

		let proc: ChildProcess;
		try {
			proc = trackDetached(
				spawn(this.buildCmd[0] as string, this.buildCmd.slice(1), {
					cwd: this.cwd,
					env: { ...process.env, ...this.env },
					stdio: [
						"ignore",
						this.verboseBuild ? "inherit" : "pipe",
						this.verboseBuild ? "inherit" : "pipe",
					],
					detached: true,
				}),
			);
		} catch (err) {
			spawnError.message = errorMessage(err);
			return { tracked: null, stdout: empty, stderr: empty, spawnError };
		}

		// A command that cannot be exec'd reports through "error", never "exit".
		proc.on("error", (err) => {
			spawnError.message = err.message;
		});

		return {
			tracked: track(proc),
			stdout: this.verboseBuild ? empty : streamToString(proc.stdout),
			stderr: this.verboseBuild ? empty : streamToString(proc.stderr),
			spawnError,
		};
	}

	/** True once a newer build or a shutdown has taken over from this generation. */
	private superseded(generation: number): boolean {
		return this.stopped || generation !== this.generation;
	}

	private async build(): Promise<void> {
		if (this.stopped) return;
		const generation = ++this.generation;
		const start = Date.now();
		logger.info("building {cmd}", { cmd: this.buildCmd.join(" ") });

		const run = this.spawnBuild();
		this.buildProc = run.tracked;

		const exitCode = run.tracked ? await run.tracked.exit : EXIT_SPAWN_FAILED;
		// A newer build or a shutdown owns the state now; do not overwrite it.
		if (this.superseded(generation)) return;
		this.buildProc = null;

		if (exitCode !== 0) {
			const failure = run.spawnError.message;
			const output = failure ? "" : await readOutput(run.stdout, run.stderr);
			if (this.superseded(generation)) return;
			this.settleFailedBuild(start, output, failure);
			return;
		}

		logger.info("built ({elapsed}s)", { elapsed: elapsed(start) });

		if (this.state === "building_with_server") {
			this.state = "swapping";
			await this.swap();
		} else {
			this.startServer();
		}

		if (this.superseded(generation)) return;
		this.rebuildIfDirty();
	}

	/** Report a build that failed or never started, then settle the state machine. */
	private settleFailedBuild(
		start: number,
		output: string,
		spawnError: string,
	): void {
		logger.error("build failed ({elapsed}s)", { elapsed: elapsed(start) });
		if (spawnError) {
			logger.error("build command could not start: {message}", {
				message: spawnError,
			});
		}
		if (output) {
			process.stderr.write(`${output}\n`);
		}

		if (this.state === "building_with_server") {
			this.state = "running";
			logger.warn("keeping previous server running");
		} else {
			this.state = "idle";
		}

		this.rebuildIfDirty();
	}

	/** Start the rebuild queued by a change that arrived while this build was busy. */
	private rebuildIfDirty(): void {
		if (!this.dirty) return;
		this.dirty = false;
		this.state = this.server ? "building_with_server" : "building";
		this.startBuild();
	}

	private async swap(): Promise<void> {
		const previous = this.server;
		this.server = null;
		if (previous) await this.stop(previous);
		this.startServer();
	}

	private startServer(): void {
		const fullCmd = [...this.runCmd, ...this.passthrough];
		let proc: ChildProcess;
		try {
			proc = trackDetached(
				spawn(fullCmd[0] as string, fullCmd.slice(1), {
					cwd: this.cwd,
					env: { ...process.env, ...this.env },
					stdio: this.json ? ["inherit", "pipe", "pipe"] : "inherit",
					detached: true,
				}),
			);
		} catch (err) {
			logger.error("server could not start: {message}", {
				message: errorMessage(err),
			});
			this.state = "idle";
			return;
		}

		// Without this listener a failed exec surfaces as an unhandled "error" event.
		proc.on("error", (err) => {
			logger.error("server could not start: {message}", {
				message: err.message,
			});
		});

		const tracked = track(proc);
		this.server = tracked;
		if (this.json) {
			pipeJsonLines(proc, this.name);
		}
		this.state = "running";
		// A failed exec has no pid; the "error" listener reports why instead.
		if (proc.pid !== undefined) {
			logger.info("server started pid {pid}", { pid: proc.pid });
		}

		tracked.exit.then((code) => {
			// Ignore unless this proc is still the current server.
			if (this.server !== tracked) return;
			this.server = null;
			if (this.state === "running") {
				logger.warn("server exited unexpectedly (code {code})", { code });
				this.state = "idle";
			}
		});
	}

	/** SIGTERM with a SIGKILL fallback, awaiting the exit promise captured at spawn. */
	private async stop(tracked: Tracked): Promise<void> {
		const cancel = escalateKill(tracked.proc);
		await tracked.exit;
		cancel();
	}

	private static killSyncOne(tracked: Tracked | null): void {
		if (!tracked) return;
		signalProc(tracked.proc, "SIGKILL");
	}

	killSync(): void {
		this.stopped = true;
		for (const w of this.watchers) w.close();
		this.watchers = [];
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		BackendWatcher.killSyncOne(this.buildProc);
		this.buildProc = null;
		BackendWatcher.killSyncOne(this.server);
		this.server = null;
		this.resolveDone(0);
	}

	async shutdown(): Promise<void> {
		this.stopped = true;
		for (const w of this.watchers) w.close();
		this.watchers = [];
		if (this.debounceTimer) clearTimeout(this.debounceTimer);

		const build = this.buildProc;
		this.buildProc = null;
		const server = this.server;
		this.server = null;
		if (build) await this.stop(build);
		if (server) await this.stop(server);
		this.resolveDone(0);
	}
}
