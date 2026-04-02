import { reexecUnderBun, shouldReexec } from "./runtime.ts";

if (shouldReexec()) {
	reexecUnderBun();
}

import { resolve } from "node:path";
import { cli, command, type Flags } from "cleye";
import pkg from "../package.json";
import { loadConfig } from "./config.ts";
import * as fmt from "./fmt.ts";
import { c } from "./fmt.ts";
import { setupLogging, teardownLogging } from "./logging/setup.ts";
import { ProcessGroup, run, runPiped } from "./proc.ts";
import { runCheck } from "./runners/check.ts";
import { runDev } from "./runners/dev.ts";
import { runFmt } from "./runners/fmt.ts";
import { runLint } from "./runners/lint.ts";
import { runPreCommit } from "./runners/pre-commit.ts";
import type {
	CommandFlagDef,
	CommandSpec,
	CustomCommandEntry,
	InferFlags,
	InlineCommandSpec,
} from "./types.ts";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: argv parsing is inherently branchy
function extractGlobalFlags(): {
	verbosity: number;
	quiet: boolean;
	logFile?: string;
	configPath?: string;
	cleaned: string[];
} {
	const args = process.argv.slice(2);
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

const globalFlags = extractGlobalFlags();
process.argv = [
	process.argv[0] as string,
	process.argv[1] as string,
	...globalFlags.cleaned,
];
await setupLogging({
	verbosity: globalFlags.verbosity,
	quiet: globalFlags.quiet,
	logFile: globalFlags.logFile,
});

async function shutdown(code: number): Promise<void> {
	await teardownLogging();
	process.exit(code);
}

ProcessGroup.registerCliSignalHandlers(async (signal) => {
	await shutdown(signal === "SIGINT" ? 130 : 143);
});

// Load config before building commands so config-defined flags can be spread into cleye
const config = await loadConfig({ configPath: globalFlags.configPath });

/** Cast config flag records to cleye's Flags type (structurally compatible, TS can't prove it) */
function cleyeFlags(flags?: Record<string, CommandFlagDef>): Flags {
	return (flags ?? {}) as unknown as Flags;
}

const checkCommand = command(
	{
		name: "check",
		parameters: ["[targets...]"],
		flags: {
			fix: {
				type: Boolean,
				description: "Auto-fix failed checks",
			},
			...cleyeFlags(config.check?.flags),
		},
		help: { description: "Parallel check orchestrator with auto-fix" },
	},
	async (argv) => {
		const exitCode = await runCheck(config, argv._.targets ?? [], argv.flags);
		await shutdown(exitCode);
	},
);

const devCommand = command(
	{
		name: "dev",
		parameters: ["[targets...]", "--", "[passthrough...]"],
		flags: {
			...cleyeFlags(config.dev?.flags),
		},
		help: { description: "Multi-process dev server manager" },
	},
	async (argv) => {
		const passthrough = argv._.passthrough ?? [];
		const exitCode = await runDev(
			config,
			argv._.targets ?? [],
			argv.flags,
			passthrough,
		);
		await shutdown(exitCode);
	},
);

const fmtCommand = command(
	{
		name: "fmt",
		alias: "format",
		parameters: ["[targets...]", "--", "[passthrough...]"],
		flags: {
			...cleyeFlags(config.fmt?.flags),
		},
		help: { description: "Sequential per-subsystem formatting" },
	},
	async (argv) => {
		const passthrough = argv._.passthrough ?? [];
		const exitCode = await runFmt(
			config,
			argv._.targets ?? [],
			argv.flags,
			passthrough,
		);
		await shutdown(exitCode);
	},
);

const lintCommand = command(
	{
		name: "lint",
		parameters: ["[targets...]", "--", "[passthrough...]"],
		flags: {
			...cleyeFlags(config.lint?.flags),
		},
		help: { description: "Sequential per-subsystem linting" },
	},
	async (argv) => {
		const passthrough = argv._.passthrough ?? [];
		const exitCode = await runLint(
			config,
			argv._.targets ?? [],
			argv.flags,
			passthrough,
		);
		await shutdown(exitCode);
	},
);

const preCommitCommand = command(
	{
		name: "pre-commit",
		flags: {
			...cleyeFlags(config.preCommit?.flags),
		},
		help: {
			description: "Staged-file auto-formatter with partial staging detection",
		},
	},
	async (argv) => {
		const exitCode = await runPreCommit(config, argv.flags);
		await shutdown(exitCode);
	},
);

async function resolveCustomSpec(
	entry: CustomCommandEntry,
	rootDir: string,
): Promise<InlineCommandSpec | null> {
	if (typeof entry === "function") {
		return { run: (ctx) => entry(ctx) };
	}
	if (typeof entry === "object") {
		return entry;
	}
	// String path — dynamic import
	const fullPath = resolve(rootDir, entry);
	try {
		const mod = await import(fullPath);
		const spec = mod.default as CommandSpec | undefined;
		if (spec && typeof spec.run === "function") {
			return spec;
		}
		console.error(
			`Invalid command at ${entry}: default export must be a defineCommand result`,
		);
		return null;
	} catch (err) {
		console.error(`Failed to import custom command ${entry}: ${err}`);
		return null;
	}
}

const customCommands: ReturnType<typeof command>[] = [];
const custom = config.custom ?? {};

for (const [name, entry] of Object.entries(custom)) {
	const spec = await resolveCustomSpec(entry, config.rootDir);
	if (!spec) continue;

	const cmd = command(
		{
			name,
			parameters: ["[args...]"],
			flags: {
				...cleyeFlags(spec.flags as Record<string, CommandFlagDef> | undefined),
			},
			help: { description: spec.description },
		},
		async (argv) => {
			const group = new ProcessGroup({ signal: "natural" });
			try {
				const exitCode = await spec.run({
					group,
					config,
					flags: (argv.flags ?? {}) as InferFlags<
						Record<string, CommandFlagDef>
					>,
					args: argv._.args ?? [],
					run,
					runPiped,
					fmt,
				});
				await shutdown(exitCode);
			} finally {
				group.dispose();
			}
		},
	);
	customCommands.push(cmd);
}

// Filter out built-in commands that are shadowed by custom commands
const customNames = new Set(Object.keys(custom));
const builtinCommands = [
	checkCommand,
	devCommand,
	fmtCommand,
	lintCommand,
	preCommitCommand,
].filter((cmd) => !customNames.has(cmd.options.name));

// Keep 'run' command only if no custom commands shadow it
const runCommand = customNames.has("run")
	? null
	: command(
			{
				name: "run",
				parameters: ["[name]", "[args...]"],
				flags: {
					list: {
						type: Boolean,
						alias: "l",
						description: "List all registered custom commands",
					},
				},
				help: {
					description:
						"Execute a custom command (alias — commands are also available as top-level subcommands)",
				},
			},
			// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: run command has many dispatch branches
			async (argv) => {
				if (argv.flags.list) {
					if (Object.keys(custom).length === 0) {
						process.stdout.write("No custom commands registered.\n");
						await shutdown(0);
					}
					process.stdout.write(`${c.bold("Custom commands:")}\n\n`);
					for (const [cmdName, entry] of Object.entries(custom)) {
						const desc = await getCustomDescription(entry, config.rootDir);
						if (desc) {
							process.stdout.write(`  ${cmdName} ${c.overlay0("—")} ${desc}\n`);
						} else {
							process.stdout.write(`  ${cmdName}\n`);
						}
					}
					await shutdown(0);
				}

				const name = argv._.name;
				if (!name) {
					console.error("Usage: tempo run <name> [args...]");
					await shutdown(1);
					return;
				}

				const entry = custom[name];
				if (!entry) {
					const available = Object.keys(custom);
					if (available.length === 0) {
						console.error(
							`Unknown command: "${name}". No custom commands registered.`,
						);
					} else {
						console.error(
							`Unknown command: "${name}". Available: ${available.join(", ")}`,
						);
					}
					await shutdown(1);
					return;
				}

				const spec = await resolveCustomSpec(entry, config.rootDir);
				if (!spec) {
					await shutdown(1);
					return;
				}

				const group = new ProcessGroup({ signal: "natural" });
				try {
					const exitCode = await spec.run({
						group,
						config,
						flags: {} as InferFlags<Record<string, CommandFlagDef>>,
						args: argv._.args ?? [],
						run,
						runPiped,
						fmt,
					});
					await shutdown(exitCode);
				} finally {
					group.dispose();
				}
			},
		);

async function getCustomDescription(
	entry: CustomCommandEntry,
	rootDir: string,
): Promise<string> {
	if (typeof entry === "function") return "";
	if (typeof entry === "object") return entry.description ?? "";
	const fullPath = resolve(rootDir, entry);
	try {
		const mod = await import(fullPath);
		const spec = mod.default as CommandSpec | undefined;
		return spec?.description ?? "";
	} catch {
		return "";
	}
}

const allCommands = [
	...builtinCommands,
	...(runCommand ? [runCommand] : []),
	...customCommands,
];

await cli({
	name: "tempo",
	version: pkg.version,
	commands: allCommands,
	help: { description: "Developer script orchestrator" },
});
