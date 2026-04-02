import type {
	AutoFixStrategy,
	CheckRenderEvent,
	CommandFlagDef,
	DevProcess,
	ExitBehavior,
	InlineCommandSpec,
	ResolvedConfig,
} from "../types.ts";
import { runCheck } from "./check.ts";
import { runDev } from "./dev.ts";
import { runPreCommit } from "./pre-commit.ts";
import { runSequential } from "./sequential.ts";

/** Require config to be present (runner factories always run with a loaded config) */
function requireConfig(config: ResolvedConfig | null): ResolvedConfig {
	if (!config) throw new Error("Runner requires a loaded config");
	return config;
}

export interface CheckRunnerOptions {
	autoFixStrategy?: AutoFixStrategy;
	exclude?: `${string}:${string}`[];
	options?: Partial<
		Record<
			string,
			{
				env?: Record<string, string>;
				hint?: string;
				warnIfExitCode?: number;
				timeout?: number;
			}
		>
	>;
	renderer?: (event: CheckRenderEvent) => void;
	flags?: Record<string, CommandFlagDef>;
}

export interface SequentialRunnerOptions {
	flags?: Record<string, CommandFlagDef>;
	autoFixFallback?: boolean;
	description?: string;
}

export interface DevRunnerOptions {
	exitBehavior?: ExitBehavior;
	processes?: Partial<Record<string, DevProcess>>;
	flags?: Record<string, CommandFlagDef>;
}

export interface PreCommitRunnerOptions {
	flags?: Record<string, CommandFlagDef>;
}

/** Parallel check orchestrator — runs all subsystem commands with auto-fix support. */
export function check(opts?: CheckRunnerOptions): InlineCommandSpec {
	const { flags: userFlags, ...checkOpts } = opts ?? {};
	return {
		description: "Parallel check orchestrator with auto-fix",
		parameters: ["[targets...]"],
		flags: {
			fix: {
				type: Boolean,
				description: "Auto-fix failed checks",
			},
			...userFlags,
		},
		_managesHooks: true,
		run: async (ctx) => {
			const config = requireConfig(ctx.config);
			const mergedConfig = {
				...config,
				check: { ...config.check, ...checkOpts },
			};
			return runCheck(mergedConfig, ctx.args, ctx.flags);
		},
	};
}

/** Sequential runner — runs `commandKey` from each targeted subsystem in order. */
export function sequential(
	commandKey: string,
	opts?: SequentialRunnerOptions,
): InlineCommandSpec {
	return {
		description:
			opts?.description ?? `Sequential per-subsystem runner: ${commandKey}`,
		parameters: ["[targets...]", "--", "[passthrough...]"],
		flags: { ...opts?.flags },
		run: async (ctx) =>
			runSequential(requireConfig(ctx.config), ctx.args, ctx.passthrough, {
				commandKey,
				loggerName: commandKey,
				autoFixFallback: opts?.autoFixFallback,
			}),
	};
}

/** Multi-process dev server manager with file watching. */
export function dev(opts?: DevRunnerOptions): InlineCommandSpec {
	const { flags: userFlags, ...devOpts } = opts ?? {};
	return {
		description: "Multi-process dev server manager",
		parameters: ["[targets...]", "--", "[passthrough...]"],
		flags: { ...userFlags },
		_managesHooks: true,
		run: async (ctx) => {
			const config = requireConfig(ctx.config);
			const mergedConfig = {
				...config,
				dev: { ...config.dev, ...devOpts },
			};
			return runDev(mergedConfig, ctx.args, ctx.flags, ctx.passthrough);
		},
	};
}

/** Staged-file auto-formatter with partial staging detection. */
export function preCommit(opts?: PreCommitRunnerOptions): InlineCommandSpec {
	return {
		description: "Staged-file auto-formatter with partial staging detection",
		flags: { ...opts?.flags },
		run: async (ctx) => runPreCommit(requireConfig(ctx.config), ctx.flags),
	};
}

/** Runner factory namespace — create InlineCommandSpec entries for built-in runners. */
export const runners = { check, sequential, dev, preCommit } as const;
