import { getLogger } from "@logtape/logtape";
import { TempoConfigError } from "../errors.ts";
import { refToString } from "../resolve.ts";
import type {
	InlineCommandSpec,
	ParallelCommandSpec,
	ResolvedConfig,
	SequentialCommandSpec,
	WatchCommandSpec,
} from "../types.ts";
import { runCheck } from "./check.ts";
import { runDev } from "./dev.ts";
import { runSequential } from "./sequential.ts";

const logger = getLogger(["tempo", "mode"]);

/** Dispatch a mode-based command spec to the appropriate executor */
export async function executeMode(
	name: string,
	spec: InlineCommandSpec,
	config: ResolvedConfig,
	flags: Record<string, unknown>,
	args: string[],
	passthrough: string[],
): Promise<number> {
	if (!spec.mode) {
		throw new TempoConfigError(
			`Internal: executeMode called on spec without mode: ${name}`,
		);
	}

	switch (spec.mode) {
		case "parallel":
			return executeParallel(name, spec, config, flags, args);
		case "sequential":
			return executeSequential(name, spec, config, args, passthrough);
		case "watch":
			return executeWatch(name, spec, config, flags, args, passthrough);
	}
}

/** Parallel mode: delegates to runCheck with merged config */
async function executeParallel(
	name: string,
	spec: ParallelCommandSpec,
	config: ResolvedConfig,
	flags: Record<string, unknown>,
	args: string[],
): Promise<number> {
	const commandKey =
		spec.commandKey === "all" ? undefined : (spec.commandKey ?? name);

	const exclude = spec.exclude?.map(refToString) as
		| `${string}:${string}`[]
		| undefined;

	const mergedConfig: ResolvedConfig = {
		...config,
		// Use spec-level preflights if provided, otherwise fall back to config
		preflights:
			spec.preflight === true
				? config.preflights
				: spec.preflight === false || spec.preflight === undefined
					? []
					: spec.preflight,
		check: {
			...config.check,
			commandKey,
			autoFixStrategy: spec.autoFix?.strategy ?? config.check?.autoFixStrategy,
			exclude: exclude ?? config.check?.exclude,
			options: spec.options ?? config.check?.options,
			renderer: spec.renderer ?? config.check?.renderer,
		},
	};

	logger.debug("parallel mode: commandKey={key}", {
		key: commandKey ?? "all",
	});

	return runCheck(mergedConfig, args, flags);
}

/** Sequential mode: delegates to runSequential */
async function executeSequential(
	name: string,
	spec: SequentialCommandSpec,
	config: ResolvedConfig,
	args: string[],
	passthrough: string[],
): Promise<number> {
	const commandKey = spec.commandKey ?? name;

	return runSequential(config, args, passthrough, {
		commandKey,
		loggerName: name,
		autoFixFallback: spec.autoFixFallback,
	});
}

/** Watch mode: delegates to runDev with merged config */
async function executeWatch(
	_name: string,
	spec: WatchCommandSpec,
	config: ResolvedConfig,
	flags: Record<string, unknown>,
	args: string[],
	passthrough: string[],
): Promise<number> {
	const mergedConfig: ResolvedConfig = {
		...config,
		dev: {
			...config.dev,
			exitBehavior: spec.exitBehavior ?? config.dev?.exitBehavior,
			processes: spec.processes ?? config.dev?.processes,
		},
	};

	return runDev(mergedConfig, args, flags, passthrough);
}
