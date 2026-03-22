import { resolve } from "node:path";
import type { ResolvedConfig, CommandSpec, CommandFlagDef } from "../types";
import { ProcessGroup, run, runPiped } from "../proc";
import { parseFlagsFromArgv } from "../flags";
import * as fmt from "../fmt";
import { dim, red, bold } from "../fmt";

export async function runCustom(
  config: ResolvedConfig,
  name: string,
  args: string[],
): Promise<number> {
  const custom = config.custom ?? {};

  if (name === "--list" || name === "-l") {
    if (Object.keys(custom).length === 0) {
      process.stdout.write(`${dim("no custom commands registered")}\n`);
      return 0;
    }
    process.stdout.write(`${bold("Custom commands:")}\n\n`);
    for (const [cmdName, cmdPath] of Object.entries(custom)) {
      const fullCmdPath = resolve(config.rootDir, cmdPath);
      let description = "";
      try {
        const mod = await import(fullCmdPath);
        const spec = mod.default as CommandSpec | undefined;
        if (spec?.description) description = spec.description;
      } catch {
        // can't load — show path as fallback
      }
      if (description) {
        process.stdout.write(`  ${cmdName} ${dim("—")} ${description}\n`);
      } else {
        process.stdout.write(`  ${cmdName} ${dim(cmdPath)}\n`);
      }
    }
    return 0;
  }

  const scriptPath = custom[name];
  if (!scriptPath) {
    const available = Object.keys(custom);
    if (available.length === 0) {
      console.error(
        `Unknown command: "${name}". No custom commands registered.`,
      );
    } else {
      console.error(
        `Unknown command: "${name}". Available: ${available.join(", ")}`,
      );
    }
    return 1;
  }

  const fullPath = resolve(config.rootDir, scriptPath);

  let mod: Record<string, unknown>;
  try {
    mod = await import(fullPath);
  } catch (err) {
    console.error(`${red("Failed to import")} ${scriptPath}: ${err}`);
    return 1;
  }

  const command = mod.default as CommandSpec | undefined;
  if (!command || typeof command.run !== "function") {
    console.error(
      `${red("Invalid command")} ${scriptPath}: default export must be a defineCommand result`,
    );
    return 1;
  }

  const { flags, positional } = command.flags
    ? parseFlagsFromArgv(
        command.flags as Record<string, CommandFlagDef>,
        args,
      )
    : { flags: {}, positional: args };

  const group = new ProcessGroup({ signal: "natural" });

  try {
    const exitCode = await command.run({
      group,
      config,
      flags: flags as any,
      args: positional,
      run,
      runPiped,
      fmt,
    });
    return exitCode;
  } finally {
    group.dispose();
  }
}
