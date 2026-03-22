/** String shorthand, array, or full object command definition */
export type CommandDef = string | string[] | CommandObject;

export interface CommandObject {
	cmd: string | string[];
	env?: Record<string, string>;
	cwd?: string;
	hint?: string;
	warnIfExitCode?: number;
	timeout?: number;
	/** Tool names that must be on PATH. Check is skipped with a warning if any are missing. */
	requires?: string[];
}

export interface SubsystemConfig<TCommands extends string = string> {
	aliases?: string[];
	cwd?: string;
	alwaysRun?: boolean;
	/** Tool names required by all commands in this subsystem. Merged with per-command requires. */
	requires?: string[];
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

export interface CheckRenderEvent {
	type:
		| "check-start"
		| "check-complete"
		| "fix-start"
		| "fix-complete"
		| "summary";
	name?: string;
	result?: CollectResult;
	results?: Map<string, CollectResult>;
}

export interface CheckConfig<TSubsystems extends string = string> {
	exclude?: `${NoInfer<TSubsystems>}:${string}`[];
	autoFixStrategy?: AutoFixStrategy;
	options?: Partial<
		Record<
			`${NoInfer<TSubsystems>}:${string}`,
			{
				env?: Record<string, string>;
				hint?: string;
				warnIfExitCode?: number;
				timeout?: number;
			}
		>
	>;
	renderer?: (event: CheckRenderEvent) => void;
}

export interface DevFlag {
	type: BooleanConstructor | StringConstructor | NumberConstructor;
	alias?: string;
	description?: string;
	default?: boolean | string | number;
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

export interface DevConfig<TSubsystems extends string = string> {
	flags?: Record<string, DevFlag>;
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
}

export interface TempoConfig<TSubsystems extends string = string> {
	subsystems: Record<TSubsystems, SubsystemConfig>;
	preflights?: PreflightDef[];
	check?: CheckConfig<TSubsystems>;
	dev?: DevConfig<TSubsystems>;
	custom?: Record<string, string>;
	ci?: CIConfig;
	hooks?: Hooks<TSubsystems>;
}

/** Config after loading and resolution — all fields populated with defaults */
export interface ResolvedConfig<TSubsystems extends string = string>
	extends TempoConfig<TSubsystems> {
	configPath: string;
	rootDir: string;
	isCI: boolean;
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
	default?: boolean | string | number;
}

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

export interface CommandContext<
	TFlags extends Record<string, CommandFlagDef> = Record<
		string,
		CommandFlagDef
	>,
> {
	group: import("./proc").ProcessGroup;
	config: ResolvedConfig | null;
	flags: InferFlags<TFlags>;
	args: string[];
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
