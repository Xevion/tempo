import type { CollectResult, SignalStrategy } from "./types";
import { yellow, dim } from "./fmt";

/** Convert a command to spawn args. Strings run via sh -c, arrays exec directly. */
export function resolveCmd(cmd: string | string[]): string[] {
  return typeof cmd === "string" ? ["sh", "-c", cmd] : cmd;
}

export class ProcessGroup {
  private children: Set<Bun.Subprocess> = new Set();
  private cleanupFns: (() => void)[] = [];
  private asyncCleanupFns: (() => Promise<void>)[] = [];
  private strategy: SignalStrategy;
  private sigintHandler: (() => Promise<void>) | null = null;
  private sigtermHandler: (() => Promise<void>) | null = null;
  public shuttingDown = false;

  constructor(options?: { signal?: SignalStrategy }) {
    this.strategy = options?.signal ?? "natural";
    this.setupSignalHandlers();
  }

  private setupSignalHandlers(): void {
    const handler = async () => {
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
          process.exit(130);
          break;
        case "immediate":
          this.killAllSync();
          process.exit(130);
          break;
      }
    };

    this.sigintHandler = handler;
    this.sigtermHandler = handler;
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
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
  }

  spawn(
    cmd: string | string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      inheritStdin?: boolean;
      ci?: boolean;
    },
  ): Bun.Subprocess {
    const args = resolveCmd(cmd);
    const proc = Bun.spawn(args, {
      cwd: options?.cwd,
      env: { ...process.env, ...options?.env },
      stdin: options?.inheritStdin ? "inherit" : "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    this.children.add(proc);
    proc.exited.then(() => this.children.delete(proc));
    return proc;
  }

  onCleanup(fn: () => void): void {
    this.cleanupFns.push(fn);
  }

  onAsyncCleanup(fn: () => Promise<void>): void {
    this.asyncCleanupFns.push(fn);
  }

  async waitForFirst(): Promise<number> {
    if (this.children.size === 0) return 0;
    const exitCode = await Promise.race(
      [...this.children].map((p) => p.exited),
    );
    await this.killAll();
    return exitCode;
  }

  async waitForAll(): Promise<number> {
    if (this.children.size === 0) return 0;
    const codes = await Promise.all(
      [...this.children].map((p) => p.exited),
    );
    return Math.max(...codes);
  }

  private killAllRunning = false;

  async killAll(): Promise<void> {
    if (this.killAllRunning) return;
    this.killAllRunning = true;

    try {
      // Run async cleanups first — they may need children alive (e.g., graceful drain)
      for (const fn of this.asyncCleanupFns) {
        try {
          await fn();
        } catch {
          // best-effort async cleanup
        }
      }
      this.asyncCleanupFns.length = 0;

      for (const child of this.children) {
        try {
          child.kill("SIGTERM");
        } catch {
          // already exited
        }
      }

      // Wait up to 5s for children to exit, then SIGKILL
      const timeout = setTimeout(() => {
        for (const child of this.children) {
          try {
            child.kill("SIGKILL");
          } catch {
            // already exited
          }
        }
      }, 5000);

      await Promise.all([...this.children].map((p) => p.exited));
      clearTimeout(timeout);
      this.children.clear();

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
    // Reset colors, show cursor, exit alt screen
    process.stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l");
    try {
      Bun.spawnSync(["stty", "sane"], { stdin: "inherit" });
    } catch {
      // stty may not be available
    }
  }
}

/** Synchronous execution with inherited stdio — exits process on failure */
export function run(
  cmd: string | string[],
  options?: { cwd?: string; env?: Record<string, string> },
): void {
  const args = resolveCmd(cmd);
  const result = Bun.spawnSync(args, {
    cwd: options?.cwd,
    env: { ...process.env, ...options?.env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}

/** Synchronous execution with piped output */
export function runPiped(
  cmd: string | string[],
  options?: { cwd?: string; env?: Record<string, string> },
): { stdout: string; stderr: string; exitCode: number } {
  const args = resolveCmd(cmd);
  const result = Bun.spawnSync(args, {
    cwd: options?.cwd,
    env: { ...process.env, ...options?.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
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
  const proc = Bun.spawn(args, {
    cwd: options?.cwd,
    env: { ...process.env, ...options?.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  if (options?.timeout) {
    killTimer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // already exited
      }
      // Force kill after 3s if SIGTERM doesn't work
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already exited
        }
      }, 3000);
    }, options.timeout * 1000);
  }

  const exitCode = await proc.exited;
  if (killTimer) clearTimeout(killTimer);

  const stdout = await new Response(proc.stdout).text();
  let stderr = await new Response(proc.stderr).text();
  if (timedOut) {
    stderr = `killed after ${options!.timeout}s timeout\n${stderr}`;
  }
  const elapsedMs = ((Date.now() - startTime) / 1000).toFixed(1);

  return {
    name: options?.name ?? args.join(" "),
    stdout,
    stderr,
    exitCode: timedOut ? 1 : exitCode,
    elapsed: elapsedMs,
  };
}

/** Parallel execution with completion-order callbacks */
export async function raceInOrder<T extends { name: string; stderr: string }>(
  promises: Promise<T>[],
  fallbacks: T[],
  onResult: (result: T) => void,
): Promise<void> {
  const remaining = new Map<Promise<T>, T>();
  for (let i = 0; i < promises.length; i++) {
    remaining.set(promises[i], fallbacks[i]);
  }

  while (remaining.size > 0) {
    const result = await Promise.race(
      [...remaining.keys()].map((p) =>
        p.then(
          (val) => ({ promise: p, val, ok: true as const }),
          (err) => {
            const fallback = remaining.get(p)!;
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

const toolCache = new Map<string, boolean>();

export function hasTool(cmd: string): boolean {
  const cached = toolCache.get(cmd);
  if (cached !== undefined) return cached;
  try {
    const result = Bun.spawnSync(["which", cmd], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const found = result.exitCode === 0;
    toolCache.set(cmd, found);
    return found;
  } catch {
    toolCache.set(cmd, false);
    return false;
  }
}

/** Collect requires from subsystem + command definition, deduped */
export function collectRequires(
  subsystemRequires: string[] | undefined,
  def: import("./types").CommandDef,
): string[] {
  const cmdRequires =
    typeof def === "object" && !Array.isArray(def) ? def.requires : undefined;
  if (!subsystemRequires?.length && !cmdRequires?.length) return [];
  return [...new Set([...(subsystemRequires ?? []), ...(cmdRequires ?? [])])];
}

/** Return tool names from a requires list that are not on PATH */
export function getMissingTools(requires: string[]): string[] {
  return requires.filter((tool) => !hasTool(tool));
}

export function warnMissingTool(cmd: string, consequence: string): void {
  if (!hasTool(cmd)) {
    process.stderr.write(
      `${yellow("warn")} ${cmd} not found: ${dim(consequence)}\n`,
    );
  }
}

export function hasDockerDaemon(): boolean {
  try {
    const result = Bun.spawnSync(["docker", "info"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export function assertPlatform(...allowed: NodeJS.Platform[]): void {
  if (!allowed.includes(process.platform)) {
    console.error(
      `Unsupported platform: ${process.platform}. Allowed: ${allowed.join(", ")}`,
    );
    process.exit(1);
  }
}
