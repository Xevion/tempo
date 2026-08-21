import type { TempoConfig } from "./types.ts";

export {
	captureCommand,
	describeRequirement,
	exitCode,
	hasTool,
	missingRequirements,
	resolveArgv,
	Spawned,
} from "./engine/exec.ts";
export { Graph, type TaskInit, task } from "./engine/graph.ts";
export {
	planLayers,
	type RunOptions,
	type RunResult,
	run,
} from "./engine/schedule.ts";
export {
	type Body,
	type Captured,
	type EngineEvent,
	type EventSink,
	GraphError,
	type Outcome,
	type Requirement,
	type RequirementPolicy,
	type RunContext,
	type Task,
	TaskFailure,
} from "./engine/types.ts";
export { type Watcher, type WatchSpec, watchPaths } from "./engine/watch.ts";
export { TempoAbortError, TempoConfigError } from "./errors.ts";
export { jsonSink, ttySink } from "./render.ts";
export type { CommandSpec, ResolvedConfig, TempoConfig } from "./types.ts";

export function defineConfig(config: TempoConfig): TempoConfig {
	return config;
}
