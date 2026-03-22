import { resolve } from "node:path";
import type { ResolvedConfig, CommandDef } from "../types";
import { run, resolveCmd, collectRequires, getMissingTools } from "../proc";
import { resolveTargets, isAll, targetLabel } from "../targets";
import { dim, yellow } from "../fmt";

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

    const requires = collectRequires(sub.requires, lintDef);
    if (requires.length > 0) {
      const missing = getMissingTools(requires);
      if (missing.length > 0) {
        process.stderr.write(
          `${yellow("skip")} ${dim(subsystem)} ${dim(`(missing: ${missing.join(", ")})`)}\n`,
        );
        continue;
      }
    }

    let cmd: string[];
    let cwd: string;

    if (typeof lintDef === "string") {
      cmd = resolveCmd(lintDef);
      cwd = sub.cwd ? resolve(config.rootDir, sub.cwd) : config.rootDir;
    } else if (Array.isArray(lintDef)) {
      cmd = lintDef;
      cwd = sub.cwd ? resolve(config.rootDir, sub.cwd) : config.rootDir;
    } else {
      cmd = resolveCmd(lintDef.cmd);
      cwd = lintDef.cwd
        ? resolve(config.rootDir, lintDef.cwd)
        : sub.cwd
          ? resolve(config.rootDir, sub.cwd)
          : config.rootDir;
    }

    if (passthrough.length > 0) {
      if (cmd[0] === "sh" && cmd[1] === "-c") {
        cmd = ["sh", "-c", cmd[2] + " " + passthrough.join(" ")];
      } else {
        cmd = [...cmd, ...passthrough];
      }
    }

    run(cmd, { cwd });
  }

  return 0;
}
