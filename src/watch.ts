import { type ChildProcess, spawn } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import { elapsed } from "./fmt.ts";
import { onExit, resolveCmd, streamToString } from "./proc.ts";

const logger = getLogger(["tempo", "watch"]);

type WatcherState =
	| "building"
	| "idle"
	| "running"
	| "building_with_server"
	| "swapping";

export class BackendWatcher {
	private state: WatcherState = "building";
	private server: ChildProcess | null = null;
	private buildProc: ChildProcess | null = null;
	private watchers: FSWatcher[] = [];
	private dirty = false;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private resolveDone!: (code: number) => void;

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
	}

	start(): void {
		this.setupWatchers();
		this.build();
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
		switch (this.state) {
			case "building":
				if (this.interrupt && this.buildProc) {
					this.buildProc.kill("SIGTERM");
					this.build();
				} else {
					this.dirty = true;
				}
				break;
			case "idle":
			case "running":
				if (this.server) {
					this.state = "building_with_server";
				} else {
					this.state = "building";
				}
				this.build();
				break;
			case "building_with_server":
				if (this.interrupt && this.buildProc) {
					this.buildProc.kill("SIGTERM");
					this.build();
				} else {
					this.dirty = true;
				}
				break;
			case "swapping":
				this.dirty = true;
				break;
		}
	}

	private async build(): Promise<void> {
		const start = Date.now();
		logger.info("building {cmd}", { cmd: this.buildCmd.join(" ") });

		this.buildProc = spawn(this.buildCmd[0]!, this.buildCmd.slice(1), {
			cwd: this.cwd,
			env: { ...process.env, ...this.env },
			stdio: [
				"ignore",
				this.verboseBuild ? "inherit" : "pipe",
				this.verboseBuild ? "inherit" : "pipe",
			],
		});

		const stdoutPromise = this.verboseBuild
			? Promise.resolve("")
			: streamToString(this.buildProc!.stdout);
		const stderrPromise = this.verboseBuild
			? Promise.resolve("")
			: streamToString(this.buildProc!.stderr);

		const exitCode = await onExit(this.buildProc!);
		this.buildProc = null;

		if (exitCode !== 0) {
			logger.error("build failed ({elapsed}s)", { elapsed: elapsed(start) });
			if (!this.verboseBuild) {
				const [stdout, stderr] = await Promise.all([
					stdoutPromise,
					stderrPromise,
				]);
				const output = (stderr || stdout).trimEnd();
				if (output) {
					process.stderr.write(`${output}\n`);
				}
			}
			if (this.state === "building_with_server") {
				this.state = "running";
				logger.warn("keeping previous server running");
			} else {
				this.state = "idle";
			}

			if (this.dirty) {
				this.dirty = false;
				this.state = "building";
				this.build();
			}
			return;
		}

		logger.info("built ({elapsed}s)", { elapsed: elapsed(start) });

		if (this.state === "building_with_server") {
			this.state = "swapping";
			await this.swap();
		} else {
			await this.startServer();
		}

		if (this.dirty) {
			this.dirty = false;
			this.state = this.server ? "building_with_server" : "building";
			this.build();
		}
	}

	private async swap(): Promise<void> {
		if (this.server) {
			this.server.kill("SIGTERM");
			const timeout = setTimeout(() => {
				try {
					this.server?.kill("SIGKILL");
				} catch {
					// already dead
				}
			}, 3000);
			await onExit(this.server);
			clearTimeout(timeout);
			this.server = null;
		}
		await this.startServer();
	}

	private async startServer(): Promise<void> {
		const fullCmd = [...this.runCmd, ...this.passthrough];
		this.server = spawn(fullCmd[0]!, fullCmd.slice(1), {
			cwd: this.cwd,
			env: { ...process.env, ...this.env },
			stdio: "inherit",
		});
		this.state = "running";
		logger.info("server started pid {pid}", { pid: this.server!.pid });
	}

	killSync(): void {
		for (const w of this.watchers) w.close();
		this.watchers = [];
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		try {
			this.buildProc?.kill("SIGKILL");
		} catch {
			// already dead
		}
		try {
			this.server?.kill("SIGKILL");
		} catch {
			// already dead
		}
		this.resolveDone(0);
	}

	async shutdown(): Promise<void> {
		for (const w of this.watchers) w.close();
		this.watchers = [];
		if (this.debounceTimer) clearTimeout(this.debounceTimer);

		if (this.buildProc) {
			this.buildProc.kill("SIGTERM");
			await onExit(this.buildProc);
		}
		if (this.server) {
			this.server.kill("SIGTERM");
			const timeout = setTimeout(() => {
				try {
					this.server?.kill("SIGKILL");
				} catch {
					// already dead
				}
			}, 3000);
			await onExit(this.server);
			clearTimeout(timeout);
		}
		this.resolveDone(0);
	}
}
