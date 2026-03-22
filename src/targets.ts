import type { TargetResult, SubsystemConfig } from "./types";

/** Resolve CLI target strings to subsystem names via alias lookup */
export function resolveTargets<T extends string>(
  args: string[],
  subsystems: Record<T, SubsystemConfig>,
): TargetResult<T> {
  const subsystemNames = Object.keys(subsystems) as T[];

  // No args = all subsystems
  if (args.length === 0) {
    return {
      subsystems: new Set(subsystemNames),
      raw: [],
    };
  }

  // Split comma-delimited args and lowercase
  const tokens = args
    .flatMap((a) => a.split(","))
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  // Build alias map: alias → subsystem name
  const aliasMap = new Map<string, T>();
  for (const name of subsystemNames) {
    aliasMap.set(name.toLowerCase(), name);
    const config = subsystems[name];
    if (config.aliases) {
      for (const alias of config.aliases) {
        aliasMap.set(alias.toLowerCase(), name);
      }
    }
  }

  const resolved = new Set<T>();
  for (const token of tokens) {
    const match = aliasMap.get(token);
    if (!match) {
      const validTargets = subsystemNames
        .map((name) => {
          const aliases = subsystems[name].aliases;
          const aliasList = aliases?.length ? ` (${aliases.join(", ")})` : "";
          return `  ${name}${aliasList}`;
        })
        .join("\n");
      console.error(`Unknown target: "${token}"\n\nValid targets:\n${validTargets}`);
      process.exit(1);
    }
    resolved.add(match);
  }

  return {
    subsystems: resolved,
    raw: tokens,
  };
}

/** Check if all subsystems are targeted */
export function isAll<T extends string>(
  result: TargetResult<T>,
  allSubsystems: T[],
): boolean {
  return result.subsystems.size === allSubsystems.length;
}

/** Format a human-readable label for the active targets */
export function targetLabel<T extends string>(
  result: TargetResult<T>,
): string {
  return [...result.subsystems].join(", ");
}
