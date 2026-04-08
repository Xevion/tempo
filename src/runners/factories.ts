import type {
	AutoFixStrategy,
	CheckRenderEvent,
	CommandFlagDef,
	DevProcess,
	ExitBehavior,
	InlineCommandSpec,
	ParallelCommandSpec,
	SequentialCommandSpec,
	SubsystemRef,
	WatchCommandSpec,
} from "../types.ts";
import { runPreCommit } from "./pre-commit.ts";

export interface CheckRunnerOptions {
	autoFixStrategy?: AutoFixStrategy;
	exclude?: SubsystemRef[];
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
export function check(opts?: CheckRunnerOptions): ParallelCommandSpec {
	const { flags: userFlags, ...rest } = opts ?? {};
	return {
		mode: "parallel",
		description: "Parallel check orchestrator with auto-fix",
		commandKey: "all",
		parameters: ["[targets...]"],
		flags: {
			fix: {
				type: Boolean,
				description: "Auto-fix failed checks",
			},
			...userFlags,
		},
		preflight: true,
		spinner: true,
		managesHooks: true,
		autoFix: rest.autoFixStrategy
			? { strategy: rest.autoFixStrategy }
			: undefined,
		exclude: rest.exclude,
		options: rest.options,
		renderer: rest.renderer,
	};
}

/** Sequential runner — runs `commandKey` from each targeted subsystem in order. */
export function sequential(
	commandKey: string,
	opts?: SequentialRunnerOptions,
): SequentialCommandSpec {
	return {
		mode: "sequential",
		description:
			opts?.description ?? `Sequential per-subsystem runner: ${commandKey}`,
		commandKey,
		parameters: ["[targets...]", "--", "[passthrough...]"],
		flags: { ...opts?.flags },
		autoFixFallback: opts?.autoFixFallback,
	};
}

/** Multi-process dev server manager with file watching. */
export function dev(opts?: DevRunnerOptions): WatchCommandSpec {
	const { flags: userFlags, ...rest } = opts ?? {};
	return {
		mode: "watch",
		description: "Multi-process dev server manager",
		parameters: ["[targets...]", "--", "[passthrough...]"],
		flags: { ...userFlags },
		managesHooks: true,
		processes: rest.processes,
		exitBehavior: rest.exitBehavior,
	};
}

/** Staged-file auto-formatter with partial staging detection. */
export function preCommit(opts?: PreCommitRunnerOptions): InlineCommandSpec {
	return {
		description: "Staged-file auto-formatter with partial staging detection",
		flags: { ...opts?.flags },
		run: async (ctx) => runPreCommit(ctx.config, ctx.flags),
	};
}

/** Runner factory namespace — create InlineCommandSpec entries for built-in runners. */
export const runners = { check, sequential, dev, preCommit } as const;
