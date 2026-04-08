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
	ResolvedConfig,
	TempoConfig,
} from "./types.ts";

export type {
	CheckConfig,
	CommandContext,
	CommandDef,
	CommandEntry,
	CommandFlagDef,
	CommandMode,
	CommandObject,
	CommandSpec,
	CommandSpecBase,
	CommandTree,
	DeclarativePreflight,
	DevConfig,
	DevProcess,
	HookContext,
	Hooks,
	InferFlags,
	InlineCommandSpec,
	ParallelCommandSpec,
	PreflightDef,
	ResolvedConfig,
	RunnerFlagsConfig,
	SequentialCommandSpec,
	SimpleCommandSpec,
	SubsystemConfig,
	SubsystemRef,
	TempoConfig,
	ToolRequirement,
	WatchCommandSpec,
} from "./types.ts";

export { DEFAULT_AUTOFIX, FORMAT_APPLY, FORMAT_CHECK } from "./types.ts";

/** Type-safe config helper — preserves subsystem name literals for downstream inference */
export function defineConfig<const TSubsystems extends string>(
	config: TempoConfig<TSubsystems>,
): TempoConfig<TSubsystems> {
	return config;
}

/** Stub config for defineCommand self-execute mode where no tempo.config.ts is loaded */
function createStubConfig(): ResolvedConfig {
	return {
		subsystems: {},
		commands: {},
		configPath: "",
		rootDir: process.cwd(),
		isCI: false,
		json: false,
		preflights: [],
		check: { autoFixStrategy: "fix-first" },
		dev: { exitBehavior: "first-exits" },
		fmt: {},
		lint: {},
		preCommit: {},
		ci: { inject: {}, groupedOutput: false },
		hooks: {},
	};
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
				flags: (spec.flags ?? {}) as import("cleye").Flags,
				help: spec.description ? { description: spec.description } : undefined,
			});

			const group = new ProcessGroup({ signal: "natural" });
			Promise.resolve(
				spec.run({
					group,
					config: createStubConfig(),
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

/** Preset namespace for convenient access */
export const presets = { rust, biome, go, gradle } as const;

export { runners } from "./runners/factories.ts";
