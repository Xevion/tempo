import { resolve } from "node:path";
import type {
  ResolvedConfig,
  CommandDef,
  CommandObject,
  CollectResult,
  CheckInfo,
  DeclarativePreflight,
  HookContext,
} from "../types";
import { spawnCollect, raceInOrder, run, resolveCmd, collectRequires, getMissingTools } from "../proc";
import { newestMtime, ensureFreshAsync } from "../preflight";
import { resolveTargets, isAll, targetLabel } from "../targets";
import { green, red, yellow, dim, bold, cyan, elapsed, isStderrTTY } from "../fmt";

function resolveCommandDef(def: CommandDef): { cmd: string[]; opts: Partial<CommandObject> } {
  if (typeof def === "string") return { cmd: resolveCmd(def), opts: {} };
  if (Array.isArray(def)) return { cmd: def, opts: {} };
  return {
    cmd: resolveCmd(def.cmd),
    opts: def,
  };
}

function isDeclarativePreflight(p: unknown): p is DeclarativePreflight {
  return typeof p === "object" && p !== null && "label" in p;
}


export async function runCheck(
  config: ResolvedConfig,
  args: string[],
  flags: { fix?: boolean },
): Promise<number> {
  const subsystemNames = Object.keys(config.subsystems) as string[];
  const targetResult = resolveTargets(args, config.subsystems);

  // Include alwaysRun subsystems
  for (const name of subsystemNames) {
    if (config.subsystems[name].alwaysRun) {
      targetResult.subsystems.add(name);
    }
  }

  const allTargeted = isAll(targetResult, subsystemNames);
  if (!allTargeted) {
    process.stderr.write(`${dim("scope:")} ${targetLabel(targetResult)}\n`);
  }

  // Run preflights
  for (const preflight of config.preflights ?? []) {
    if (isDeclarativePreflight(preflight)) {
      const sourceMtime = newestMtime(
        resolve(config.rootDir, preflight.sources.dir),
        preflight.sources.pattern,
      );
      await ensureFreshAsync({
        label: preflight.label,
        sourceMtime,
        artifactDir: resolve(config.rootDir, preflight.artifacts.dir),
        artifactGlob: preflight.artifacts.pattern,
        reason: preflight.reason,
        regenerate: async () => {
          if (typeof preflight.regenerate === "function") {
            await preflight.regenerate();
          } else {
            run(preflight.regenerate, { cwd: config.rootDir });
          }
        },
      });
    } else {
      await preflight();
    }
  }

  // Build check list
  const checks: { name: string; subsystem: string; action: string; def: CommandDef }[] = [];
  const excluded = new Set(config.check?.exclude ?? []);

  for (const subsystem of targetResult.subsystems) {
    const sub = config.subsystems[subsystem];
    if (!sub.commands) continue;
    for (const [action, def] of Object.entries(sub.commands)) {
      const checkName = `${subsystem}:${action}`;
      if (excluded.has(checkName as `${string}:${string}`)) continue;

      const requires = collectRequires(sub.requires, def as CommandDef);
      if (requires.length > 0) {
        const missing = getMissingTools(requires);
        if (missing.length > 0) {
          process.stderr.write(
            `${yellow("skip")} ${dim(checkName)} ${dim(`(missing: ${missing.join(", ")})`)}\n`,
          );
          continue;
        }
      }

      checks.push({ name: checkName, subsystem, action, def: def as CommandDef });
    }
  }

  if (checks.length === 0) {
    process.stderr.write(`${dim("no checks to run")}\n`);
    return 0;
  }

  // Build hook context
  const cleanupFns: (() => void | Promise<void>)[] = [];
  const hookEnv: Record<string, string> = {};
  const hookCtx: HookContext = {
    config,
    flags,
    targets: targetResult.subsystems as Set<string>,
    env: hookEnv,
    addCleanup: (fn) => cleanupFns.push(fn),
  };

  // Run before:check hook
  if (config.hooks?.["before:check"]) {
    await config.hooks["before:check"](hookCtx);
  }

  // CI env injection
  const envOverrides: Record<string, string> = { ...hookEnv };
  if (config.isCI && config.ci?.inject) {
    Object.assign(envOverrides, config.ci.inject);
  }

  // Auto-fix: fix-first strategy
  if (flags.fix && config.check?.autoFixStrategy !== "fix-on-fail") {
    for (const subsystem of targetResult.subsystems) {
      const sub = config.subsystems[subsystem];
      if (!sub.autoFix || !sub.commands) continue;
      for (const [checkAction, fixAction] of Object.entries(sub.autoFix)) {
        const fixDef = sub.commands[fixAction as string];
        if (!fixDef) continue;
        const fixRequires = collectRequires(sub.requires, fixDef as CommandDef);
        if (fixRequires.length > 0 && getMissingTools(fixRequires).length > 0) continue;
        const { cmd } = resolveCommandDef(fixDef as CommandDef);
        process.stderr.write(`${cyan("fix")} ${dim(`${subsystem}:${fixAction}`)}\n`);
        run(cmd, {
          cwd: sub.cwd ? resolve(config.rootDir, sub.cwd) : config.rootDir,
          env: envOverrides,
        });
      }
    }
  }

  // Spawn all checks in parallel
  const startTime = Date.now();
  const promises: Promise<CollectResult>[] = [];
  const fallbacks: CollectResult[] = [];

  for (const check of checks) {
    const { cmd, opts } = resolveCommandDef(check.def);
    const sub = config.subsystems[check.subsystem];
    const checkOpts = config.check?.options?.[check.name as `${string}:${string}`];

    const env = {
      ...envOverrides,
      ...opts.env,
      ...checkOpts?.env,
    };
    const cwd = opts.cwd
      ? resolve(config.rootDir, opts.cwd)
      : sub.cwd
        ? resolve(config.rootDir, sub.cwd)
        : config.rootDir;

    // Run before:check:each hook
    if (config.hooks?.["before:check:each"]) {
      const info: CheckInfo = { name: check.name, subsystem: check.subsystem, action: check.action, cmd };
      await config.hooks["before:check:each"](hookCtx, info);
    }

    const timeout = opts.timeout ?? checkOpts?.timeout;
    promises.push(
      spawnCollect(cmd, startTime, { cwd, env, name: check.name, timeout }),
    );
    fallbacks.push({
      name: check.name,
      stdout: "",
      stderr: "check timed out or was interrupted",
      exitCode: 1,
      elapsed: "0.0",
    });
  }

  const renderer = config.check?.renderer;

  // TUI spinner (only when no custom renderer)
  let spinnerInterval: ReturnType<typeof setInterval> | undefined;
  const remaining = new Set(checks.map((c) => c.name));

  if (!renderer && isStderrTTY && !config.isCI) {
    spinnerInterval = setInterval(() => {
      const el = elapsed(startTime);
      const names = [...remaining].join(", ");
      process.stderr.write(`\r\x1b[K${dim(`${el}s`)} ${dim(names)}`);
    }, 100);
  }

  // Collect results
  const results = new Map<string, CollectResult>();
  let hasFailure = false;

  await raceInOrder(promises, fallbacks, (result) => {
    remaining.delete(result.name);
    results.set(result.name, result);

    const check = checks.find((c) => c.name === result.name)!;
    const checkOpts = config.check?.options?.[result.name as `${string}:${string}`];
    const { opts } = resolveCommandDef(check.def);
    const hint = opts.hint ?? checkOpts?.hint;
    const warnCode = opts.warnIfExitCode ?? checkOpts?.warnIfExitCode;

    if (renderer) {
      renderer({ type: "check-complete", name: result.name, result });
    } else {
      // Clear spinner line
      if (isStderrTTY && !config.isCI) {
        process.stderr.write("\r\x1b[K");
      }

      // CI grouped output
      if (config.isCI && config.ci?.groupedOutput) {
        process.stdout.write(`::group::${result.name}\n`);
      }

      if (result.exitCode === 0) {
        process.stdout.write(
          `${green("✓")} ${result.name} ${dim(`(${result.elapsed}s)`)}\n`,
        );
      } else if (warnCode !== undefined && result.exitCode === warnCode) {
        process.stdout.write(
          `${yellow("⚠")} ${result.name} ${dim(`(${result.elapsed}s)`)}\n`,
        );
      } else {
        hasFailure = true;
        process.stdout.write(
          `${red("✗")} ${result.name} ${dim(`(${result.elapsed}s)`)}\n`,
        );
        if (hint) {
          process.stdout.write(`  ${dim("hint:")} ${hint}\n`);
        } else {
          if (result.stdout.trim()) process.stdout.write(result.stdout);
          if (result.stderr.trim()) process.stderr.write(result.stderr);
        }
      }

      if (config.isCI && config.ci?.groupedOutput) {
        process.stdout.write("::endgroup::\n");
      }
    }

    // Determine failure for renderer path too
    if (renderer && result.exitCode !== 0) {
      if (warnCode === undefined || result.exitCode !== warnCode) {
        hasFailure = true;
      }
    }

    // Run after:check:each hook (fire and forget for perf)
    if (config.hooks?.["after:check:each"]) {
      const info: CheckInfo = { name: check.name, subsystem: check.subsystem, action: check.action, cmd: [] };
      config.hooks["after:check:each"](hookCtx, info, result);
    }
  });

  if (spinnerInterval) clearInterval(spinnerInterval);

  // Auto-fix: fix-on-fail strategy
  if (flags.fix && config.check?.autoFixStrategy === "fix-on-fail" && hasFailure) {
    const fixedChecks: typeof checks = [];

    for (const [name, result] of results) {
      if (result.exitCode === 0) continue;
      const check = checks.find((c) => c.name === name);
      if (!check) continue;

      const sub = config.subsystems[check.subsystem];
      if (!sub.autoFix || !sub.commands) continue;

      const fixAction = sub.autoFix[check.action];
      if (!fixAction) continue;

      const fixDef = sub.commands[fixAction];
      if (!fixDef) continue;

      const { cmd } = resolveCommandDef(fixDef as CommandDef);
      process.stderr.write(`${cyan("fix")} ${dim(`${check.subsystem}:${fixAction}`)}\n`);
      run(cmd, {
        cwd: sub.cwd ? resolve(config.rootDir, sub.cwd) : config.rootDir,
        env: envOverrides,
      });
      fixedChecks.push(check);
    }

    // Re-verify fixed checks
    if (fixedChecks.length > 0) {
      process.stderr.write(`${dim("re-verifying fixed checks...")}\n`);
      const reStartTime = Date.now();
      const rePromises: Promise<CollectResult>[] = [];
      const reFallbacks: CollectResult[] = [];

      for (const check of fixedChecks) {
        const { cmd, opts } = resolveCommandDef(check.def);
        const sub = config.subsystems[check.subsystem];
        const cwd = opts.cwd
          ? resolve(config.rootDir, opts.cwd)
          : sub.cwd
            ? resolve(config.rootDir, sub.cwd)
            : config.rootDir;

        rePromises.push(spawnCollect(cmd, reStartTime, { cwd, env: envOverrides, name: check.name }));
        reFallbacks.push({ name: check.name, stdout: "", stderr: "", exitCode: 1, elapsed: "0.0" });
      }

      hasFailure = false;
      await raceInOrder(rePromises, reFallbacks, (result) => {
        results.set(result.name, result);
        if (result.exitCode === 0) {
          process.stdout.write(`${green("✓")} ${result.name} ${dim("(fixed)")} ${dim(`(${result.elapsed}s)`)}\n`);
        } else {
          hasFailure = true;
          process.stdout.write(`${red("✗")} ${result.name} ${dim("(still failing)")} ${dim(`(${result.elapsed}s)`)}\n`);
        }
      });
    }
  }

  // Run after:check hook
  if (config.hooks?.["after:check"]) {
    await config.hooks["after:check"](hookCtx, results);
  }

  // Cleanup
  for (const fn of cleanupFns) {
    try {
      await fn();
    } catch {
      // best-effort
    }
  }

  // Summary
  const total = results.size;
  const passed = [...results.values()].filter((r) => r.exitCode === 0).length;
  const totalElapsed = elapsed(startTime);

  if (renderer) {
    renderer({ type: "summary", results });
  } else if (hasFailure) {
    process.stdout.write(
      `\n${red(bold(`${passed}/${total} passed`))} ${dim(`(${totalElapsed}s)`)}\n`,
    );
  } else {
    process.stdout.write(
      `\n${green(bold(`${total}/${total} passed`))} ${dim(`(${totalElapsed}s)`)}\n`,
    );
  }

  return hasFailure ? 1 : 0;
}
