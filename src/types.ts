/** Well-known command names for the format protocol used by pre-commit */
export const FORMAT_CHECK = "format-check" as const;
export const FORMAT_APPLY = "format-apply" as const;

/** Default autoFix mapping used by all built-in presets */
export const DEFAULT_AUTOFIX = {
	[FORMAT_CHECK]: FORMAT_APPLY,
} as const;

/** A tool requirement: bare name or object with optional install hint */
export type ToolRequirement = string | { tool: string; hint?: string };

/** String shorthand, array, or full object command definition */
export type CommandDef = string | string[] | CommandObject;

export interface CommandObject {
	cmd: string | string[];
	env?: Record<string, string>;
	cwd?: string;
	warnIfExitCode?: number;
	timeout?: number;
	/** Tool names that must be on PATH. Check is skipped with a warning if any are missing. */
	requires?: ToolRequirement[];
}

export interface SubsystemConfig<TCommands extends string = string> {
	aliases?: string[];
	cwd?: string;
	alwaysRun?: boolean;
	/** Tool names required by all commands in this subsystem. Merged with per-command requires. */
	requires?: ToolRequirement[];
	commands?: Record<TCommands, CommandDef>;
	autoFix?: Partial<Record<NoInfer<TCommands>, NoInfer<TCommands>>>;
}

export interface DeclarativePreflight {
	label: string;
	sources: { dir: string; pattern: string };
	artifacts: { dir: string; pattern: string };
	regenerate: string | string[] | (() => void | Promise<void>);
	reason?: string;
}

export interface PreflightContext {
	logger: TempoLogger;
	fail(message: string): never;
}

export type PreflightDef =
	| DeclarativePreflight
	| ((ctx: PreflightContext) => void | Promise<void>);

export type AutoFixStrategy = "fix-first" | "fix-on-fail";

export interface SkippedCheck {
	name: string;
	missing: string[];
	hints: Map<string, string>;
}

export interface CheckRenderEvent {
	type:
		| "check-start"
		| "check-complete"
		| "check-skip"
		| "fix-start"
		| "fix-complete"
		| "summary";
	name?: string;
	result?: CollectResult;
	results?: Map<string, CollectResult>;
	skipped?: SkippedCheck;
	skippedCount?: number;
}

export interface CheckConfig<TSubsystems extends string = string> {
	flags?: Record<string, CommandFlagDef>;
	exclude?: (
		| `${NoInfer<TSubsystems>}:${string}`
		| [NoInfer<TSubsystems>, string]
	)[];
	autoFixStrategy?: AutoFixStrategy;
	/** When set, only run this specific command key from each subsystem instead of all commands. */
	commandKey?: string;
	options?: Partial<
		Record<
			`${NoInfer<TSubsystems>}:${string}`,
			{
				env?: Record<string, string>;
				warnIfExitCode?: number;
				timeout?: number;
			}
		>
	>;
	renderer?: (event: CheckRenderEvent) => void;
}

export interface UnmanagedProcess {
	type: "unmanaged";
	cmd: string | string[];
	cwd?: string;
	env?: Record<string, string>;
}

export interface ManagedProcess {
	type: "managed";
	watch: {
		dirs: string[];
		exts: string[];
		extraPaths?: string[];
		debounce?: number;
	};
	build: {
		cmd: string | string[];
		verbose?: boolean;
	};
	run: {
		cmd: string | string[];
		passthrough?: boolean;
	};
	interrupt?: boolean;
	cwd?: string;
	env?: Record<string, string>;
}

export type DevProcess = UnmanagedProcess | ManagedProcess;

export type ExitBehavior = "first-exits" | "all-exit";

/** Shared config shape for runners that only accept custom flags */
export interface RunnerFlagsConfig {
	flags?: Record<string, CommandFlagDef>;
}

export interface DevConfig<TSubsystems extends string = string> {
	flags?: Record<string, CommandFlagDef>;
	exitBehavior?: ExitBehavior;
	processes?: Partial<Record<NoInfer<TSubsystems>, DevProcess>>;
}

export interface CIConfig {
	enabled?: boolean;
	inject?: Record<string, string>;
	groupedOutput?: boolean;
}

export interface TempoLogger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface HookContext<TSubsystems extends string = string> {
	config: ResolvedConfig<TSubsystems>;
	flags: Record<string, unknown>;
	targets: Set<TSubsystems>;
	env: Record<string, string>;
	logger: TempoLogger;
	addCleanup(fn: () => void | Promise<void>): void;
	/** Log an error message and abort the current runner */
	fail(message: string): never;
}

export interface CheckInfo {
	name: string;
	subsystem: string;
	action: string;
	cmd: string | string[];
}

export interface Hooks<TSubsystems extends string = string> {
	// Runner-specific hooks with typed signatures
	"before:check"?: (ctx: HookContext<TSubsystems>) => Promise<void> | void;
	"after:check"?: (
		ctx: HookContext<TSubsystems>,
		results: Map<string, CollectResult>,
	) => Promise<void> | void;
	"before:check:each"?: (
		ctx: HookContext<TSubsystems>,
		check: CheckInfo,
	) => Promise<void> | void;
	"after:check:each"?: (
		ctx: HookContext<TSubsystems>,
		check: CheckInfo,
		result: CollectResult,
	) => Promise<void> | void;
	"before:dev"?: (ctx: HookContext<TSubsystems>) => Promise<void> | void;
	"after:dev"?: (ctx: HookContext<TSubsystems>) => Promise<void> | void;
	// Generic before:/after: hooks for any command name
	[key: `before:${string}`]:
		| // biome-ignore lint/suspicious/noExplicitAny: index signature must be wide enough for all specific overloads
		((ctx: HookContext<TSubsystems>, ...args: any[]) => Promise<void> | void)
		| undefined;
	[key: `after:${string}`]:
		| // biome-ignore lint/suspicious/noExplicitAny: index signature must be wide enough for all specific overloads
		((ctx: HookContext<TSubsystems>, ...args: any[]) => Promise<void> | void)
		| undefined;
}

export interface TempoConfig<TSubsystems extends string = string> {
	subsystems: Record<TSubsystems, SubsystemConfig>;
	preflights?: PreflightDef[];
	/** Unified command tree — all CLI subcommands (built-in runners + custom). */
	commands: CommandTree;
	check?: CheckConfig<TSubsystems>;
	dev?: DevConfig<TSubsystems>;
	fmt?: RunnerFlagsConfig;
	lint?: RunnerFlagsConfig;
	preCommit?: RunnerFlagsConfig;
	ci?: CIConfig;
	hooks?: Hooks<TSubsystems>;
	/** Preferred runtime. When set and mismatched, tempo re-execs under the correct runtime. */
	runtime?: "bun" | "node";
}

/** Config after loading and resolution — all fields populated with defaults */
export interface ResolvedConfig<TSubsystems extends string = string>
	extends TempoConfig<TSubsystems> {
	configPath: string;
	rootDir: string;
	isCI: boolean;
	/** When true, all output is emitted as JSON Lines to stdout */
	json: boolean;
	/** Always populated after resolution — contains all registered CLI subcommands. */
	commands: CommandTree;
}

export interface CollectResult {
	name: string;
	stdout: string;
	stderr: string;
	exitCode: number;
	/** Seconds with 1 decimal, e.g. "1.2" */
	elapsed: string;
}

export type SignalStrategy = "natural" | "graceful" | "immediate";

export interface CommandFlagDef {
	type: BooleanConstructor | StringConstructor | NumberConstructor;
	alias?: string;
	description?: string;
	placeholder?: string;
	default?: boolean | string | number;
}

/** Execution modes for orchestrated commands */
export type CommandMode = "parallel" | "sequential" | "watch";

/**
 * Reference to a subsystem:command pair.
 * Accepts colon-separated string or tuple form.
 */
export type SubsystemRef<TSubsystems extends string = string> =
	| `${TSubsystems}:${string}`
	| [TSubsystems, string];

/** Shared fields present on all InlineCommandSpec variants */
export interface CommandSpecBase<
	TFlags extends Record<string, CommandFlagDef> = Record<
		string,
		CommandFlagDef
	>,
> {
	name?: string;
	description?: string;
	flags?: TFlags;
	/** Cleye parameter definitions, e.g. ["[targets...]", "--", "[passthrough...]"] */
	parameters?: string[];
	/** Command alias(es) for cleye, e.g. "format" for the fmt command */
	alias?: string | string[];
	/** When true, the command manages its own before:/after: hook lifecycle internally (skip generic dispatch) */
	managesHooks?: boolean;
}

/** Simple command — user-provided run function, no orchestration */
export interface SimpleCommandSpec<
	TFlags extends Record<string, CommandFlagDef> = Record<
		string,
		CommandFlagDef
	>,
> extends CommandSpecBase<TFlags> {
	mode?: undefined;
	run: (ctx: CommandContext<TFlags>) => Promise<number> | number;
}

/** Parallel mode — runs subsystem commands concurrently (like check runner) */
export interface ParallelCommandSpec<
	TFlags extends Record<string, CommandFlagDef> = Record<
		string,
		CommandFlagDef
	>,
> extends CommandSpecBase<TFlags> {
	mode: "parallel";
	/** Which subsystem command to run. Defaults to the command's own name. Use 'all' to run every command from each subsystem (check-style). */
	commandKey?: string | "all";
	/** Preflight checks: true = use config.preflights, array = use these specific preflights */
	preflight?: boolean | PreflightDef[];
	/** Auto-fix configuration */
	autoFix?: { strategy: AutoFixStrategy };
	/** Show TUI spinner during execution (default: true for parallel) */
	spinner?: boolean;
	/** Subsystem:command pairs to exclude from execution */
	exclude?: SubsystemRef[];
	/** Per-check overrides (env, timeout, warnIfExitCode) keyed by subsystem:command */
	options?: Partial<
		Record<
			string,
			{
				env?: Record<string, string>;
				warnIfExitCode?: number;
				timeout?: number;
			}
		>
	>;
	/** Custom renderer for check events (replaces default spinner + line output) */
	renderer?: (event: CheckRenderEvent) => void;
	run?: undefined;
}

/** Sequential mode — runs one command from each subsystem in order */
export interface SequentialCommandSpec<
	TFlags extends Record<string, CommandFlagDef> = Record<
		string,
		CommandFlagDef
	>,
> extends CommandSpecBase<TFlags> {
	mode: "sequential";
	/** Which subsystem command to run. Defaults to the command's own name. */
	commandKey?: string;
	/** Fall back to autoFix commands when primary commandKey is missing */
	autoFixFallback?: boolean;
	run?: undefined;
}

/** Watch mode — manages long-lived processes with file watching (like dev runner) */
export interface WatchCommandSpec<
	TFlags extends Record<string, CommandFlagDef> = Record<
		string,
		CommandFlagDef
	>,
> extends CommandSpecBase<TFlags> {
	mode: "watch";
	/** Per-subsystem process definitions */
	processes?: Partial<Record<string, DevProcess>>;
	/** How to handle process exits */
	exitBehavior?: ExitBehavior;
	run?: undefined;
}

/** A command spec for inline use where the config key provides the name */
export type InlineCommandSpec<
	TFlags extends Record<string, CommandFlagDef> = Record<
		string,
		CommandFlagDef
	>,
> =
	| SimpleCommandSpec<TFlags>
	| ParallelCommandSpec<TFlags>
	| SequentialCommandSpec<TFlags>
	| WatchCommandSpec<TFlags>;

export interface CommandSpec<
	TFlags extends Record<string, CommandFlagDef> = Record<
		string,
		CommandFlagDef
	>,
> {
	name: string;
	description?: string;
	flags?: TFlags;
	run: (ctx: CommandContext<TFlags>) => Promise<number> | number;
}

/** A command entry: file path, bare function, or inline CommandSpec */
export type CommandEntry =
	| InlineCommandSpec
	| ((
			ctx: CommandContext<Record<never, CommandFlagDef>>,
	  ) => Promise<number> | number)
	| string
	| false
	| CommandTree;

export interface CommandContext<
	TFlags extends Record<string, CommandFlagDef> = Record<
		string,
		CommandFlagDef
	>,
> {
	group: import("./proc").ProcessGroup;
	config: ResolvedConfig;
	flags: InferFlags<TFlags>;
	args: string[];
	passthrough: string[];
	run: typeof import("./proc").run;
	runPiped: typeof import("./proc").runPiped;
	fmt: typeof import("./fmt");
}

type InferFlagType<T extends CommandFlagDef> =
	T["type"] extends BooleanConstructor
		? boolean
		: T["type"] extends StringConstructor
			? string
			: T["type"] extends NumberConstructor
				? number
				: unknown;

export type InferFlags<T extends Record<string, CommandFlagDef>> = {
	[K in keyof T]: InferFlagType<T[K]>;
};

export interface TargetResult<T extends string> {
	subsystems: Set<T>;
	raw: string[];
}

/**
 * A command entry in the unified command tree.
 *
 * Discrimination:
 * - `typeof entry === 'function'` → bare function
 * - `typeof entry === 'string'` → file path for dynamic import
 * - `entry === false` → explicitly disabled
 * - `typeof entry === 'object' && typeof entry.run === 'function'` → SimpleCommandSpec
 * - `typeof entry === 'object' && 'mode' in entry` → mode-based spec (ParallelCommandSpec | SequentialCommandSpec | WatchCommandSpec)
 * - `typeof entry === 'object' && typeof entry.run !== 'function' && !('mode' in entry)` → CommandTree (nested group)
 */

/** Recursive record of command entries — supports nested command groups. */
export interface CommandTree {
	[key: string]: CommandEntry;
}
