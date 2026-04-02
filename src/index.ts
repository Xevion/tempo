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
	CommandEntry,
	CommandFlagDef,
	CommandObject,
	CommandSpec,
	CommandTree,
	CustomCommandEntry,
	CustomCommandFn,
	DeclarativePreflight,
	DevConfig,
	DevProcess,
	ExitBehavior,
	FmtConfig,
	HookContext,
	Hooks,
	InferFlags,
	InlineCommandSpec,
	LintConfig,
	ManagedProcess,
	PreCommitConfig,
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
		import("cleye").then(({ cli: cleyeCli }) => {
			const parsed = cleyeCli({
				name: spec.name,
				flags: (spec.flags ?? {}) as unknown as import("cleye").Flags,
				help: spec.description ? { description: spec.description } : undefined,
			});

			const group = new ProcessGroup({ signal: "natural" });
			Promise.resolve(
				spec.run({
					group,
					config: null,
					flags: parsed.flags as InferFlags<TFlags>,
					args: parsed._,
					passthrough: [],
					run,
					runPiped,
					fmt,
				}),
			).then((code) => {
				group.dispose();
				process.exit(code);
			});
		});
	}

	return spec;
}

export { biome, go, gradle, rust };

/** Preset namespace for convenient access */
export const presets = { rust, biome, go, gradle } as const;

export { runners } from "./runners/factories.ts";
