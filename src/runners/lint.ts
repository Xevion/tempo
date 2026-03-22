import { resolve } from "node:path";
import type { ResolvedConfig, CommandDef } from "../types";
import { run } from "../proc";
import { resolveTargets, isAll, targetLabel } from "../targets";
import { dim, parseArgs } from "../fmt";

export async function runLint(
  config: ResolvedConfig,
  args: string[],
  passthrough: string[],
): Promise<number> {
  const subsystemNames = Object.keys(config.subsystems) as string[];
  const targetResult = resolveTargets(args, config.subsystems);

  if (!isAll(targetResult, subsystemNames)) {
    process.stderr.write(`${dim("scope:")} ${targetLabel(targetResult)}\n`);
  }

  for (const subsystem of targetResult.subsystems) {
    const sub = config.subsystems[subsystem];
    if (!sub.commands) continue;

    const lintDef: CommandDef | undefined = sub.commands["lint"];
    if (!lintDef) continue;

    let cmd: string[];
    let cwd: string;

    if (typeof lintDef === "string") {
      cmd = parseArgs(lintDef);
      cwd = sub.cwd ? resolve(config.rootDir, sub.cwd) : config.rootDir;
    } else if (Array.isArray(lintDef)) {
      cmd = lintDef;
      cwd = sub.cwd ? resolve(config.rootDir, sub.cwd) : config.rootDir;
    } else {
      cmd = typeof lintDef.cmd === "string" ? parseArgs(lintDef.cmd) : lintDef.cmd;
      cwd = lintDef.cwd
        ? resolve(config.rootDir, lintDef.cwd)
        : sub.cwd
          ? resolve(config.rootDir, sub.cwd)
          : config.rootDir;
    }

    if (passthrough.length > 0) {
      cmd = [...cmd, ...passthrough];
    }

    run(cmd, { cwd });
  }

  return 0;
}
