import type { RequirementPolicy, Task } from "./engine/types.ts";

/**
 * A command is a selector over the task registry, not a runner.
 *
 * `check` selects everything tagged `check`; `fmt` selects `format`. One-off
 * commands are the same mechanism with an explicit task list.
 */
export interface CommandSpec {
	description?: string;
	tags?: string[];
	tasks?: string[];
	concurrency?: number;
	requirementPolicy?: RequirementPolicy;
	/** first-exits ends the run when the first persistent task exits. */
	exitBehavior?: "first-exits" | "all-exit";
	/**
	 * Treat positional arguments as arguments rather than as selectors.
	 *
	 * For a command whose own arguments are the point (`tempo db reset`) rather
	 * than one selecting a subset of a matrix (`tempo check backend`).
	 */
	passthrough?: boolean;
}

export interface TempoConfig {
	tasks: Task[];
	commands?: Record<string, CommandSpec>;
	concurrency?: number;
	runtime?: "bun" | "node";
}

export interface ResolvedConfig extends TempoConfig {
	configPath: string;
	rootDir: string;
	isCI: boolean;
	json: boolean;
}
