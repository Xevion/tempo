import { reexecUnderBun, shouldReexec } from "./runtime.ts";

if (shouldReexec()) {
	reexecUnderBun();
}

import { resolve } from "node:path";
import { getLogger } from "@logtape/logtape";
import { cli, command, type Flags } from "cleye";
import pkg from "../package.json";
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
	logFile?: string;
	configPath?: string;
	cleaned: string[];
} {
	const args = argv ?? process.argv.slice(2);
	let verbosity = 0;
	let quiet = false;
	let logFile: string | undefined;
	let configPath: string | undefined;
	const cleaned: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		const vMatch = /^-(v{1,3})$/.exec(arg);
		if (vMatch) {
			verbosity += (vMatch[1] as string).length;
		} else if (arg === "-q" || arg === "--quiet") {
			quiet = true;
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

	return { verbosity, quiet, logFile, configPath, cleaned };
}

async function shutdown(code: number): Promise<void> {
	await teardownLogging();
	process.exit(code);
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
		try {
			const mod = await import(fullPath);
			const spec = mod.default as CommandSpec | undefined;
			if (spec && typeof spec.run === "function") {
				return spec;
			}
			logger.error(
				"invalid command at {entry}: default export must be a defineCommand result",
				{ entry },
			);
			return null;
		} catch (err) {
			logger.error("failed to import custom command {entry}: {err}", {
				entry,
				err,
			});
			return null;
		}
	}
	// Object with `run` → InlineCommandSpec
	if ("run" in entry && typeof entry.run === "function") {
		return entry as InlineCommandSpec;
	}
	// Otherwise it's a nested group — handled by buildCommands, not here
	return null;
}

/** Check if a CommandEntry is a nested command group */
function isCommandGroup(entry: CommandEntry): entry is CommandTree {
	return typeof entry === "object" && entry !== null && !("run" in entry);
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

		const exitCode = await spec.run({
			group,
			config,
			flags: (flags ?? {}) as InferFlags<Record<string, CommandFlagDef>>,
			args: extractArgs(positionals),
			passthrough: extractPassthrough(positionals),
			run,
			runPiped,
			fmt,
		});

		if (!spec.managesHooks) {
			await runCommandHook(config, `after:${name}`, flags);
		}

		await shutdown(exitCode);
	} catch (err) {
		if (err instanceof TempoAbortError) {
			await shutdown(1);
		}
		if (err instanceof TempoRunError) {
			await shutdown(err.exitCode);
		}
		throw err;
	} finally {
		for (const fn of cleanupFns) {
			try {
				await fn();
			} catch {}
		}
		group.dispose();
	}
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
							name: `tempo ${name}`,
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

/** Extract positional args from cleye's parsed positionals (targets or args) */
// biome-ignore lint/suspicious/noExplicitAny: cleye's positional types vary per command definition
function extractArgs(positionals: any): string[] {
	return positionals?.targets ?? positionals?.args ?? [];
}

/** Extract passthrough args from cleye's parsed positionals */
// biome-ignore lint/suspicious/noExplicitAny: cleye's positional types vary per command definition
function extractPassthrough(positionals: any): string[] {
	return positionals?.passthrough ?? [];
}

export async function main(argv?: string[]): Promise<void> {
	const globalFlags = extractGlobalFlags(argv);
	const cleanedArgv = globalFlags.cleaned;
	await setupLogging({
		verbosity: globalFlags.verbosity,
		quiet: globalFlags.quiet,
		logFile: globalFlags.logFile,
	});

	ProcessGroup.registerCliSignalHandlers(async (signal) => {
		await shutdown(exitCodeForSignal(signal));
	});

	// Register virtual modules before loading config so `import from "@xevion/tempo"` works
	await initRegistration();

	// Load config before building commands so config-defined flags can be spread into cleye
	const config = await loadConfig({ configPath: globalFlags.configPath });

	const allCommands = await buildCommands(config.commands, config, cleanedArgv);

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

main().catch(async (err) => {
	if (err instanceof TempoConfigError || err instanceof TempoTargetError) {
		logger.error(err.message);
		await teardownLogging();
		process.exit(1);
	}
	if (err instanceof TempoRunError) {
		await teardownLogging();
		process.exit(err.exitCode);
	}
	throw err;
});
