import { cli, command } from "cleye";
import pkg from "../package.json";
import { loadConfig } from "./config.ts";
import { parseFlagsFromArgv } from "./flags.ts";
import { setupLogging, teardownLogging } from "./logging/setup.ts";
import { ProcessGroup } from "./proc.ts";
import { runCheck } from "./runners/check.ts";
import { runDev } from "./runners/dev.ts";
import { runFmt } from "./runners/fmt.ts";
import { runLint } from "./runners/lint.ts";
import { runPreCommit } from "./runners/pre-commit.ts";
import { runCustom } from "./runners/run.ts";
import type { CommandFlagDef } from "./types.ts";

function extractGlobalFlags(): {
	verbosity: number;
	quiet: boolean;
	logFile?: string;
	cleaned: string[];
} {
	const args = process.argv.slice(2);
	let verbosity = 0;
	let quiet = false;
	let logFile: string | undefined;
	const cleaned: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		const vMatch = /^-(v{1,3})$/.exec(arg);
		if (vMatch) {
			verbosity += vMatch[1]!.length;
		} else if (arg === "-q" || arg === "--quiet") {
			quiet = true;
		} else if (arg === "--log-file" && args[i + 1]) {
			logFile = args[++i];
		} else if (arg.startsWith("--log-file=")) {
			logFile = arg.slice("--log-file=".length);
		} else {
			cleaned.push(arg);
		}
	}

	return { verbosity, quiet, logFile, cleaned };
}

const globalFlags = extractGlobalFlags();
process.argv = [process.argv[0]!, process.argv[1]!, ...globalFlags.cleaned];
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

const checkCommand = command(
	{
		name: "check",
		parameters: ["[targets...]"],
		flags: {
			fix: {
				type: Boolean,
				description: "Auto-fix failed checks",
			},
			config: {
				type: String,
				description: "Override config file path",
				placeholder: "<path>",
			},
		},
		help: { description: "Parallel check orchestrator with auto-fix" },
	},
	async (argv) => {
		const config = await loadConfig({ configPath: argv.flags.config });
		const exitCode = await runCheck(config, argv._.targets ?? [], {
			fix: argv.flags.fix,
		});
		await shutdown(exitCode);
	},
);

const devCommand = command(
	{
		name: "dev",
		parameters: ["[targets...]", "--", "[passthrough...]"],
		flags: {
			config: {
				type: String,
				description: "Override config file path",
				placeholder: "<path>",
			},
		},
		help: { description: "Multi-process dev server manager" },
	},
	async (argv) => {
		const config = await loadConfig({ configPath: argv.flags.config });
		const passthrough = argv._.passthrough ?? [];

		let devFlags: Record<string, unknown> = {};
		if (config.dev?.flags && Object.keys(config.dev.flags).length > 0) {
			const flagSpec = config.dev.flags as Record<string, CommandFlagDef>;
			const devArgIndex = process.argv.indexOf("dev");
			if (devArgIndex !== -1) {
				const rawDevArgs = process.argv.slice(devArgIndex + 1);
				const filtered: string[] = [];
				for (let i = 0; i < rawDevArgs.length; i++) {
					if (rawDevArgs[i] === "--") break;
					if (rawDevArgs[i] === "--config") {
						i++;
						continue;
					}
					filtered.push(rawDevArgs[i]!);
				}
				const parsed = parseFlagsFromArgv(flagSpec, filtered);
				devFlags = parsed.flags;
			}
		}

		const mergedFlags = { ...argv.flags, ...devFlags };
		const exitCode = await runDev(
			config,
			argv._.targets ?? [],
			mergedFlags,
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
			config: {
				type: String,
				description: "Override config file path",
				placeholder: "<path>",
			},
		},
		help: { description: "Sequential per-subsystem formatting" },
	},
	async (argv) => {
		const config = await loadConfig({ configPath: argv.flags.config });
		const passthrough = argv._.passthrough ?? [];
		const exitCode = await runFmt(config, argv._.targets ?? [], passthrough);
		await shutdown(exitCode);
	},
);

const lintCommand = command(
	{
		name: "lint",
		parameters: ["[targets...]", "--", "[passthrough...]"],
		flags: {
			config: {
				type: String,
				description: "Override config file path",
				placeholder: "<path>",
			},
		},
		help: { description: "Sequential per-subsystem linting" },
	},
	async (argv) => {
		const config = await loadConfig({ configPath: argv.flags.config });
		const passthrough = argv._.passthrough ?? [];
		const exitCode = await runLint(config, argv._.targets ?? [], passthrough);
		await shutdown(exitCode);
	},
);

const preCommitCommand = command(
	{
		name: "pre-commit",
		flags: {
			config: {
				type: String,
				description: "Override config file path",
				placeholder: "<path>",
			},
		},
		help: {
			description: "Staged-file auto-formatter with partial staging detection",
		},
	},
	async (argv) => {
		const config = await loadConfig({ configPath: argv.flags.config });
		const exitCode = await runPreCommit(config);
		await shutdown(exitCode);
	},
);

const runCommand = command(
	{
		name: "run",
		parameters: ["[name]", "[args...]"],
		flags: {
			config: {
				type: String,
				description: "Override config file path",
				placeholder: "<path>",
			},
			list: {
				type: Boolean,
				alias: "l",
				description: "List all registered custom commands",
			},
		},
		help: {
			description: "Execute a custom command registered via defineCommand",
		},
	},
	async (argv) => {
		const config = await loadConfig({ configPath: argv.flags.config });

		if (argv.flags.list) {
			const exitCode = await runCustom(config, "--list", []);
			await shutdown(exitCode);
		}

		const name = argv._.name;
		if (!name) {
			console.error("Usage: tempo run <name> [args...]");
			await shutdown(1);
			return;
		}

		const exitCode = await runCustom(config, name, argv._.args ?? []);
		await shutdown(exitCode);
	},
);

await cli({
	name: "tempo",
	version: pkg.version,
	commands: [
		checkCommand,
		devCommand,
		fmtCommand,
		lintCommand,
		preCommitCommand,
		runCommand,
	],
	help: { description: "Developer script orchestrator" },
});
