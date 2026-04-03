import {
	DEFAULT_AUTOFIX,
	FORMAT_APPLY,
	FORMAT_CHECK,
	type SubsystemConfig,
} from "../types.ts";

export interface BiomePresetOptions {
	svelte?: boolean;
	vitest?: boolean;
	cwd?: string;
}

export function biome(options?: BiomePresetOptions): SubsystemConfig {
	const commands: Record<string, string> = {
		[FORMAT_CHECK]: "bunx biome check .",
		[FORMAT_APPLY]: "bunx biome check --write .",
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
		...(options?.cwd && { cwd: options.cwd }),
		aliases: ["biome", "web", "front"],
		commands,
		autoFix: DEFAULT_AUTOFIX,
	};
}
