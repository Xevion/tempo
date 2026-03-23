import { parseFlagsFromArgv } from "./flags.ts";
import * as fmt from "./fmt.ts";
import { biome } from "./presets/biome.ts";
import { go } from "./presets/go.ts";
import { gradle } from "./presets/gradle.ts";
import { rust } from "./presets/rust.ts";
import { ProcessGroup, run, runPiped } from "./proc.ts";
import type {
	CommandFlagDef,
	CommandSpec,
	InferFlags,
	TempoConfig,
} from "./types.ts";

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
	CustomCommandEntry,
	CustomCommandFn,
	DeclarativePreflight,
	DevConfig,
	DevFlag,
	DevProcess,
	ExitBehavior,
	HookContext,
	Hooks,
	InferFlags,
	InlineCommandSpec,
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
} from "./types.ts";

export {
	parseIntOption,
	resolveEnumOption,
	ValidationError,
} from "./utils/validation.ts";

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
				flags: flags as InferFlags<TFlags>,
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
