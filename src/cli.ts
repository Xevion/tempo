import { reexecUnderBun, shouldReexec } from "./runtime.ts";

if (shouldReexec()) {
	reexecUnderBun();
}

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getLogger } from "@logtape/logtape";
import { cli, command, type Flags } from "cleye";
import pkg from "../package.json" with { type: "json" };
import { loadConfig } from "./config.ts";
import {
	TempoAbortError,
	TempoConfigError,
	TempoRunError,
	TempoTargetError,
} from "./errors.ts";
import * as fmt from "./fmt.ts";
import { exitCodeForSignal } from "./fmt.ts";
import { runCommandHook } from "./hooks.ts";
import { emitJson, nowIso } from "./logging/json.ts";
import { setupLogging, teardownLogging } from "./logging/setup.ts";
import { ProcessGroup, run, runPiped } from "./proc.ts";
import { initRegistration } from "./register.ts";
import type {
	CommandEntry,
	CommandFlagDef,
	CommandSpec,
	CommandTree,
	InferFlags,
	InlineCommandSpec,
	ResolvedConfig,
} from "./types.ts";

const logger = getLogger(["tempo", "cli"]);

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: argv parsing is inherently branchy
function extractGlobalFlags(argv?: string[]): {
	verbosity: number;
	quiet: boolean;
	json: boolean;
	logFile?: string;
	configPath?: string;
	cleaned: string[];
} {
	const args = argv ?? process.argv.slice(2);
	let verbosity = 0;
	let quiet = false;
	let json = false;
	let logFile: string | undefined;
	let configPath: string | undefined;
	const cleaned: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		// Everything from the first `--` belongs to the command, not to tempo.
		if (arg === "--") {
			cleaned.push(...args.slice(i));
			break;
		}
		const vMatch = /^-(v{1,3})$/.exec(arg);
		if (vMatch) {
			verbosity += (vMatch[1] as string).length;
		} else if (arg === "-q" || arg === "--quiet") {
			quiet = true;
		} else if (arg === "--json") {
			json = true;
		} else if (arg === "--log-file" && args[i + 1]) {
			logFile = args[++i];
		} else if (arg.startsWith("--log-file=")) {
			logFile = arg.slice("--log-file=".length);
		} else if (arg === "--config" && args[i + 1]) {
			configPath = args[++i];
		} else if (arg.startsWith("--config=")) {
			configPath = arg.slice("--config=".length);
		} else {
			cleaned.push(arg);
		}
	}

	if (process.env.LOG_FORMAT === "json") json = true;

	return { verbosity, quiet, json, logFile, configPath, cleaned };
}

/** Set once sinks exist; before that, logger calls would be dropped silently. */
let loggingReady = false;

async function shutdown(code: number): Promise<never> {
	await teardownLogging();
	process.exit(code);
}

function reportFatal(message: string): void {
	if (loggingReady) logger.error(message);
	else process.stderr.write(`tempo: ${message}\n`);
}

/** Terminal handler for anything that escapes main; rethrowing here would become an unhandled rejection. */
async function fatal(err: unknown): Promise<never> {
	if (err instanceof TempoRunError) return shutdown(err.exitCode);
	if (err instanceof TempoConfigError || err instanceof TempoTargetError) {
		reportFatal(err.message);
		return shutdown(1);
	}
	if (err instanceof TempoAbortError) {
		reportFatal(err.message ? `aborted: ${err.message}` : "aborted");
		return shutdown(1);
	}
	const message = err instanceof Error ? err.message : String(err);
	reportFatal(`fatal: ${message}`);
	if (err instanceof Error && err.stack) logger.debug(err.stack);
	return shutdown(1);
}

/** True when a root-level flag is given before any subcommand or `--` terminator. */
function wantsRootFlag(argv: string[], names: string[]): boolean {
	for (const arg of argv) {
		if (arg === "--") return false;
		if (names.includes(arg)) return true;
		if (!arg.startsWith("-")) return false;
	}
	return false;
}

function runtimeLabel(): string {
	const versions = process.versions as Record<string, string | undefined>;
	if (versions.bun) return `bun ${versions.bun}`;
	if (versions.deno) return `deno ${versions.deno}`;
	return `node ${versions.node}`;
}

/** Short HEAD sha of the checkout tempo runs from, suffixed `-dirty` when the tree has changes. */
function gitBuild(root: string): string | null {
	if (!existsSync(join(root, ".git"))) return null;
	const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const commit = head.status === 0 ? head.stdout.trim() : "";
	if (!commit) return null;
	const status = spawnSync("git", ["status", "--porcelain"], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const dirty = status.status === 0 && status.stdout.trim().length > 0;
	return dirty ? `${commit}-dirty` : commit;
}

/** Report which tempo is actually executing: version, build identity, entrypoint, runtime. */
function printVersion(json: boolean): void {
	const entry = fileURLToPath(import.meta.url);
	const build = gitBuild(resolve(dirname(entry), ".."));
	const runtime = runtimeLabel();
	if (json) {
		emitJson({
			ts: nowIso(),
			type: "version",
			version: pkg.version,
			build,
			path: entry,
			runtime,
		});
		return;
	}
	process.stdout.write(
		[
			`tempo ${pkg.version}`,
			`build    ${build ?? "unknown"}`,
			`path     ${entry}`,
			`runtime  ${runtime}`,
			"",
		].join("\n"),
	);
}

/** Cast config flag records to cleye's Flags type (CommandFlagDef is structurally a FlagSchema, but cleye's union includes bare FlagType which prevents direct assignment) */
function cleyeFlags(flags?: Record<string, CommandFlagDef>): Flags {
	return (flags ?? {}) as unknown as Flags;
}

/** Resolve a CommandEntry to an InlineCommandSpec (or null if disabled/invalid) */
async function resolveSpec(
	entry: CommandEntry,
	rootDir: string,
): Promise<InlineCommandSpec | null> {
	if (entry === false) return null;
	if (typeof entry === "function") {
		return { run: (ctx) => entry(ctx) };
	}
	if (typeof entry === "string") {
		const fullPath = resolve(rootDir, entry);
		let mod: Record<string, unknown>;
		try {
			mod = await import(fullPath);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new TempoConfigError(
				`Failed to import custom command from ${fullPath}: ${message}`,
			);
		}
		const spec = mod.default as CommandSpec | undefined;
		if (!spec || typeof spec.run !== "function") {
			throw new TempoConfigError(
				`Invalid command at ${fullPath}: default export must be a defineCommand result`,
			);
		}
		return spec;
	}
	// Object with `run` → SimpleCommandSpec
	if ("run" in entry && typeof entry.run === "function") {
		return entry as InlineCommandSpec;
	}
	// Object with `mode` → mode-based spec (parallel/sequential/watch)
	if ("mode" in entry && typeof entry.mode === "string") {
		return entry as InlineCommandSpec;
	}
	// Otherwise it's a nested group — handled by buildCommands, not here
	return null;
}

/** Check if a CommandEntry is a nested command group (not an InlineCommandSpec).
 *  InlineCommandSpec has `run` as a function; a CommandTree may have a `run` key
 *  that is itself a nested CommandEntry (object/string/function), not the spec's runner. */
function isCommandGroup(entry: CommandEntry): entry is CommandTree {
	return (
		typeof entry === "object" &&
		entry !== null &&
		(!("run" in entry) || typeof entry.run !== "function") &&
		!(
			"mode" in entry &&
			typeof (entry as Record<string, unknown>).mode === "string"
		)
	);
}

/** Log a thrown error and map it to an exit code, without exiting: cleanups still have to run. */
function exitCodeForError(name: string, err: unknown): number {
	if (err instanceof TempoAbortError) {
		if (err.message) logger.error("aborted: {reason}", { reason: err.message });
		else logger.error("aborted");
		return 1;
	}
	if (err instanceof TempoRunError) return err.exitCode;
	if (err instanceof TempoConfigError || err instanceof TempoTargetError) {
		logger.error(err.message);
		return 1;
	}
	const message = err instanceof Error ? err.message : String(err);
	logger.error("command {name} failed: {message}", { name, message });
	if (err instanceof Error && err.stack) logger.debug(err.stack);
	return 1;
}

/** Drain hook cleanups best-effort, reporting failures instead of hiding them. */
async function drainCleanups(
	name: string,
	fns: (() => void | Promise<void>)[],
): Promise<void> {
	for (const fn of fns) {
		try {
			await fn();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn("cleanup for {name} failed: {message}", { name, message });
			if (err instanceof Error && err.stack) logger.debug(err.stack);
		}
	}
}

/** Execute a command spec with hook dispatch, cleanup, and error handling */
async function executeCommand(
	name: string,
	spec: InlineCommandSpec,
	config: ResolvedConfig,
	flags: Record<string, unknown>,
	// biome-ignore lint/suspicious/noExplicitAny: cleye's positional types vary per command definition
	positionals: any,
): Promise<void> {
	const group = new ProcessGroup({ signal: "natural" });
	const cleanupFns: (() => void | Promise<void>)[] = [];
	let exitCode: number;
	try {
		if (!spec.managesHooks) {
			const { cleanupFns: hookCleanups, hookEnv } = await runCommandHook(
				config,
				`before:${name}`,
				flags,
			);
			cleanupFns.push(...hookCleanups);
			Object.assign(process.env, hookEnv);
		}

		if (spec.mode) {
			const { executeMode } = await import("./runners/mode-dispatch.ts");
			exitCode = await executeMode(
				name,
				spec,
				config,
				flags,
				extractArgs(positionals),
				extractPassthrough(positionals),
			);
		} else {
			exitCode = await spec.run({
				group,
				config,
				flags: (flags ?? {}) as InferFlags<Record<string, CommandFlagDef>>,
				args: extractArgs(positionals),
				passthrough: extractPassthrough(positionals),
				run,
				runPiped,
				fmt,
			});
		}

		if (!spec.managesHooks) {
			await runCommandHook(config, `after:${name}`, flags);
		}
	} catch (err) {
		exitCode = exitCodeForError(name, err);
	} finally {
		await drainCleanups(name, cleanupFns);
		group.dispose();
	}

	await shutdown(exitCode);
}

/** Build cleye command array from a CommandTree, handling nesting via re-dispatch */
async function buildCommands(
	tree: CommandTree,
	config: ResolvedConfig,
	argv: string[],
): Promise<ReturnType<typeof command>[]> {
	const commands: ReturnType<typeof command>[] = [];

	for (const [name, entry] of Object.entries(tree)) {
		if (entry === false) continue;

		if (isCommandGroup(entry)) {
			const nestedTree = entry;
			const cmd = command(
				{
					name,
					help: { description: `Command group: ${name}` },
					ignoreArgv: () => true,
				},
				async () => {
					const groupIdx = argv.indexOf(name);
					const nestedArgv = groupIdx >= 0 ? argv.slice(groupIdx + 1) : [];
					const nestedCommands = await buildCommands(
						nestedTree,
						config,
						nestedArgv,
					);
					await cli(
						{
							name,
							commands: nestedCommands,
							help: { description: `Commands under ${name}` },
						},
						undefined,
						nestedArgv,
					);
				},
			);
			commands.push(cmd);
			continue;
		}

		const spec = await resolveSpec(entry, config.rootDir);
		if (!spec) continue;

		const cmd = command(
			{
				name,
				alias: spec.alias,
				parameters: spec.parameters ?? ["[args...]"],
				flags: {
					...cleyeFlags(
						spec.flags as Record<string, CommandFlagDef> | undefined,
					),
				},
				help: { description: spec.description },
			},
			(argv) => executeCommand(name, spec, config, argv.flags, argv._),
		);
		commands.push(cmd);
	}

	return commands;
}

// cleye's `_` is an array of all positionals plus `_['--']` (passthrough,
// also appended to the tail). Leading args = raw array minus that tail.
// biome-ignore lint/suspicious/noExplicitAny: cleye's positional types vary per command definition
function extractArgs(positionals: any): string[] {
	if (!positionals) return [];
	const all: string[] = Array.isArray(positionals) ? [...positionals] : [];
	const passthrough: string[] = positionals["--"] ?? [];
	return passthrough.length > 0
		? all.slice(0, all.length - passthrough.length)
		: all;
}

/** Extract passthrough args (everything after `--`) from cleye's parsed `_`. */
// biome-ignore lint/suspicious/noExplicitAny: cleye's positional types vary per command definition
function extractPassthrough(positionals: any): string[] {
	return positionals?.["--"] ?? [];
}

export async function main(argv?: string[]): Promise<void> {
	const globalFlags = extractGlobalFlags(argv);
	const cleanedArgv = globalFlags.cleaned;

	// Identity must be answerable outside a project, before any config work.
	if (wantsRootFlag(cleanedArgv, ["--version"])) {
		printVersion(globalFlags.json);
		return;
	}

	await setupLogging({
		verbosity: globalFlags.verbosity,
		quiet: globalFlags.quiet,
		json: globalFlags.json,
		logFile: globalFlags.logFile,
	});
	loggingReady = true;

	ProcessGroup.registerCliSignalHandlers(async (signal) => {
		await shutdown(exitCodeForSignal(signal));
	});

	// Register virtual modules before loading config so `import from "@xevion/tempo"` works
	await initRegistration();

	// Load config before building commands so config-defined flags can be spread into cleye
	let config: ResolvedConfig | null = null;
	try {
		config = await loadConfig({
			configPath: globalFlags.configPath,
			json: globalFlags.json,
		});
	} catch (err) {
		// `--help` still answers outside a project; it just lists no commands.
		if (
			!(err instanceof TempoConfigError) ||
			!wantsRootFlag(cleanedArgv, ["--help", "-h"])
		) {
			throw err;
		}
		logger.warn(err.message);
	}

	const allCommands = config
		? await buildCommands(config.commands, config, cleanedArgv)
		: [];

	await cli(
		{
			name: "tempo",
			version: pkg.version,
			commands: allCommands,
			help: { description: "Developer script orchestrator" },
		},
		undefined,
		cleanedArgv,
	);
}

main().catch(fatal);
