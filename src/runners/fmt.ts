import { resolve } from "node:path";
import type { ResolvedConfig, CommandDef } from "../types";
import { run, resolveCmd } from "../proc";
import { resolveTargets, isAll, targetLabel } from "../targets";
import { dim } from "../fmt";

export async function runFmt(
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

    // Look for format-apply command, or fall back to autoFix values
    let fmtDef: CommandDef | undefined = sub.commands["format-apply"];
    if (!fmtDef && sub.autoFix) {
      for (const fixAction of Object.values(sub.autoFix)) {
        if (sub.commands[fixAction as string]) {
          fmtDef = sub.commands[fixAction as string];
          break;
        }
      }
    }

    if (!fmtDef) continue;

    let cmd: string[];
    let cwd: string;

    if (typeof fmtDef === "string") {
      cmd = resolveCmd(fmtDef);
      cwd = sub.cwd ? resolve(config.rootDir, sub.cwd) : config.rootDir;
    } else if (Array.isArray(fmtDef)) {
      cmd = fmtDef;
      cwd = sub.cwd ? resolve(config.rootDir, sub.cwd) : config.rootDir;
    } else {
      cmd = resolveCmd(fmtDef.cmd);
      cwd = fmtDef.cwd
        ? resolve(config.rootDir, fmtDef.cwd)
        : sub.cwd
          ? resolve(config.rootDir, sub.cwd)
          : config.rootDir;
    }

    // Append passthrough args — for sh -c commands, join into the shell string
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
