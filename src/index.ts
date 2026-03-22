import { parseFlagsFromArgv } from "./flags";
import * as fmt from "./fmt";
import { biome } from "./presets/biome";
import { go } from "./presets/go";
import { gradle } from "./presets/gradle";
import { rust } from "./presets/rust";
import { ProcessGroup, run, runPiped } from "./proc";
import type { CommandFlagDef, CommandSpec, TempoConfig } from "./types";

export type {
	AutoFixStrategy,
	CheckConfig,
	CheckInfo,
	CIConfig,
	CollectResult,
	CommandContext,
	CommandDef,
	CommandFlagDef,
	CommandObject,
	CommandSpec,
	DeclarativePreflight,
	DevConfig,
	DevFlag,
	DevProcess,
	ExitBehavior,
	HookContext,
	Hooks,
	InferFlags,
	ManagedProcess,
	PreflightContext,
	PreflightDef,
	ResolvedConfig,
	SignalStrategy,
	SubsystemConfig,
	TargetResult,
	TempoConfig,
	TempoLogger,
	UnmanagedProcess,
} from "./types";

export {
	parseIntOption,
	resolveEnumOption,
	ValidationError,
} from "./utils/validation";

/** Type-safe config helper — preserves subsystem name literals for downstream inference */
export function defineConfig<const TSubsystems extends string>(
	config: TempoConfig<TSubsystems>,
): TempoConfig<TSubsystems> {
	return config;
}

/**
 * Define a custom command that works both via `tempo run` and direct `bun` execution.
 *
 * Pass `import.meta.main` as the second arg for dual-mode:
 * ```ts
 * export default defineCommand({ ... }, import.meta.main);
 * ```
 */
export function defineCommand<
	TFlags extends Record<string, CommandFlagDef> = Record<
		string,
		CommandFlagDef
	>,
>(spec: CommandSpec<TFlags>, selfExecute?: boolean): CommandSpec<TFlags> {
	if (selfExecute) {
		const args = process.argv.slice(2);
		const { flags, positional } = spec.flags
			? parseFlagsFromArgv(spec.flags as Record<string, CommandFlagDef>, args)
			: { flags: {}, positional: args };

		const group = new ProcessGroup({ signal: "natural" });

		Promise.resolve(
			spec.run({
				group,
				config: null,
				flags: flags as any,
				args: positional,
				run,
				runPiped,
				fmt,
			}),
		).then((code) => {
			group.dispose();
			process.exit(code);
		});
	}

	return spec;
}

export { biome, go, gradle, rust };

/** Preset namespace for convenient access */
export const presets = { rust, biome, go, gradle } as const;
