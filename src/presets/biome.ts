import type { SubsystemConfig } from "../types";

export interface BiomePresetOptions {
  svelte?: boolean;
  vitest?: boolean;
  cwd?: string;
}

export function biome(options?: BiomePresetOptions): SubsystemConfig {
  const commands: Record<string, string> = {
    "format-check": "bunx biome check .",
    "format-apply": "bunx biome check --write .",
    lint: "bunx biome lint .",
    build: "bun run build",
  };

  if (options?.svelte) {
    commands["type-check"] = "bun run check";
  }

  const includeVitest = options?.vitest ?? options?.svelte ?? false;
  if (includeVitest) {
    commands.test = "bunx vitest run";
  }

  return {
    aliases: ["biome", "web", "front"],
    commands,
    autoFix: {
      "format-check": "format-apply",
    },
  };
}
