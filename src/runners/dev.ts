import { resolve } from "node:path";
import type { ResolvedConfig, HookContext } from "../types";
import { ProcessGroup, TempoAbortError } from "../proc";
import { BackendWatcher } from "../watch";
import { resolveTargets, isAll, targetLabel } from "../targets";
import { dim, green, cyan, yellow, red } from "../fmt";

export async function runDev(
  config: ResolvedConfig,
  args: string[],
  flags: Record<string, unknown>,
  passthrough: string[],
): Promise<number> {
  const subsystemNames = Object.keys(config.subsystems) as string[];
  const targetResult = resolveTargets(args, config.subsystems);

  const allTargeted = isAll(targetResult, subsystemNames);
  if (!allTargeted) {
    process.stderr.write(`${dim("scope:")} ${targetLabel(targetResult)}\n`);
  }

  const group = new ProcessGroup({ signal: "natural" });

  // Build hook context
  const cleanupFns: (() => void | Promise<void>)[] = [];
  const hookEnv: Record<string, string> = {};
  const hookCtx: HookContext = {
    config,
    flags,
    targets: targetResult.subsystems as Set<string>,
    env: hookEnv,
    logger: {
      info: (msg: string) => process.stderr.write(`${cyan("info")} ${msg}\n`),
      warn: (msg: string) => process.stderr.write(`${yellow("warn")} ${msg}\n`),
      error: (msg: string) => process.stderr.write(`${red("error")} ${msg}\n`),
    },
    addCleanup: (fn) => cleanupFns.push(fn),
    fail: (msg: string): never => {
      process.stderr.write(`${red("error")} ${msg}\n`);
      throw new TempoAbortError(msg);
    },
  };

  // Run before:dev hook
  if (config.hooks?.["before:dev"]) {
    try {
      await config.hooks["before:dev"](hookCtx);
    } catch (e) {
      if (e instanceof TempoAbortError) return 1;
      throw e;
    }
  }

  const envOverrides: Record<string, string> = { ...hookEnv };

  // Spawn processes
  const processes = config.dev?.processes ?? {};
  for (const subsystem of targetResult.subsystems) {
    const procDef = processes[subsystem as keyof typeof processes];
    if (!procDef) continue;

    const sub = config.subsystems[subsystem];
    const baseCwd = sub.cwd ? resolve(config.rootDir, sub.cwd) : config.rootDir;

    if (procDef.type === "unmanaged") {
      const cwd = procDef.cwd ? resolve(config.rootDir, procDef.cwd) : baseCwd;
      const env = { ...envOverrides, ...procDef.env };
      process.stderr.write(`${green("start")} ${dim(subsystem)} ${dim("(unmanaged)")}\n`);
      group.spawn(procDef.cmd, { cwd, env, inheritStdin: true });
    } else if (procDef.type === "managed") {
      const cwd = procDef.cwd ? resolve(config.rootDir, procDef.cwd) : baseCwd;
      const env = { ...envOverrides, ...procDef.env };
      const passthroughArgs = procDef.run.passthrough ? passthrough : [];

      process.stderr.write(`${green("start")} ${dim(subsystem)} ${dim("(managed)")}\n`);

      const watcher = new BackendWatcher(group, {
        watchDirs: procDef.watch.dirs,
        watchExts: procDef.watch.exts,
        extraPaths: procDef.watch.extraPaths,
        buildCmd: procDef.build.cmd,
        runCmd: procDef.run.cmd,
        debounce: procDef.watch.debounce,
        interrupt: procDef.interrupt,
        verboseBuild: procDef.build.verbose,
        cwd,
        env,
        passthrough: passthroughArgs,
      });

      group.onCleanup(() => watcher.killSync());
      group.onAsyncCleanup(() => watcher.shutdown());
      watcher.start();
    }
  }

  // Wait based on exit behavior
  const exitBehavior = config.dev?.exitBehavior ?? "first-exits";
  let exitCode: number;

  if (exitBehavior === "first-exits") {
    exitCode = await group.waitForFirst();
  } else {
    exitCode = await group.waitForAll();
  }

  // Run after:dev hook
  if (config.hooks?.["after:dev"]) {
    await config.hooks["after:dev"](hookCtx);
  }

  // Cleanup
  for (const fn of cleanupFns) {
    try {
      await fn();
    } catch {
      // best-effort
    }
  }

  return exitCode;
}
