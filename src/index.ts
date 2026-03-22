import type { TempoConfig, CommandSpec, CommandFlagDef } from "./types";
import { ProcessGroup, run, runPiped } from "./proc";
import { parseFlagsFromArgv } from "./flags";
import * as fmt from "./fmt";
import { rust } from "./presets/rust";
import { biome } from "./presets/biome";
import { go } from "./presets/go";
import { gradle } from "./presets/gradle";

export type {
  TempoConfig,
  ResolvedConfig,
  SubsystemConfig,
  CommandDef,
  CommandObject,
  CollectResult,
  SignalStrategy,
  CommandSpec,
  CommandContext,
  CommandFlagDef,
  InferFlags,
  DevFlag,
  DevProcess,
  UnmanagedProcess,
  ManagedProcess,
  PreflightDef,
  DeclarativePreflight,
  AutoFixStrategy,
  ExitBehavior,
  CIConfig,
  CheckConfig,
  DevConfig,
  Hooks,
  HookContext,
  TempoLogger,
  PreflightContext,
  CheckInfo,
  TargetResult,
} from "./types";

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
      ? parseFlagsFromArgv(
          spec.flags as Record<string, CommandFlagDef>,
          args,
        )
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

export { rust, biome, go, gradle };

/** Preset namespace for convenient access */
export const presets = { rust, biome, go, gradle } as const;
