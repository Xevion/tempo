import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { type ProcessGroup, resolveCmd } from "./proc";
import { dim, cyan, green, red, yellow, elapsed } from "./fmt";

type WatcherState =
  | "building"
  | "idle"
  | "running"
  | "building_with_server"
  | "swapping";

export class BackendWatcher {
  private group: ProcessGroup;
  private state: WatcherState = "building";
  private server: Bun.Subprocess | null = null;
  private buildProc: Bun.Subprocess | null = null;
  private watchers: FSWatcher[] = [];
  private dirty = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

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

  constructor(
    group: ProcessGroup,
    options: {
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
    },
  ) {
    this.group = group;
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
        const watcher = watch(fullDir, { recursive: true }, (_event, filename) => {
          if (!filename) return;
          const ext = "." + filename.split(".").pop();
          if (this.watchExts.has(ext)) {
            this.onFileChange();
          }
        });
        this.watchers.push(watcher);
      } catch {
        // directory may not exist yet
      }
    }

    // Watch extra paths (individual files or globs)
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
    process.stderr.write(`${cyan("building")} ${dim(this.buildCmd.join(" "))}\n`);

    this.buildProc = Bun.spawn(this.buildCmd, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdin: "ignore",
      stdout: this.verboseBuild ? "inherit" : "pipe",
      stderr: this.verboseBuild ? "inherit" : "pipe",
    });

    const exitCode = await this.buildProc.exited;
    this.buildProc = null;

    if (exitCode !== 0) {
      process.stderr.write(`${red("build failed")} ${dim(`(${elapsed(start)}s)`)}\n`);
      if (this.state === "building_with_server") {
        // Keep old server running on build failure
        this.state = "running";
        process.stderr.write(`${yellow("keeping previous server running")}\n`);
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

    process.stderr.write(`${green("built")} ${dim(`(${elapsed(start)}s)`)}\n`);

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
      await this.server.exited;
      clearTimeout(timeout);
      this.server = null;
    }
    await this.startServer();
  }

  private async startServer(): Promise<void> {
    const fullCmd = [...this.runCmd, ...this.passthrough];
    this.server = Bun.spawn(fullCmd, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    this.state = "running";
    process.stderr.write(
      `${green("server started")} ${dim(`pid ${this.server.pid}`)}\n`,
    );
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
  }

  async shutdown(): Promise<void> {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    if (this.buildProc) {
      this.buildProc.kill("SIGTERM");
      await this.buildProc.exited;
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
      await this.server.exited;
      clearTimeout(timeout);
    }
  }
}
