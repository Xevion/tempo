import { resolve } from "node:path";
import { getLogger } from "@logtape/logtape";
import { parseFlagsFromArgv } from "../flags.ts";
import * as fmt from "../fmt.ts";
import { c } from "../fmt.ts";
import { ProcessGroup, run, runPiped } from "../proc.ts";
import type {
	CommandFlagDef,
	CommandSpec,
	CustomCommandEntry,
	InlineCommandSpec,
	ResolvedConfig,
} from "../types.ts";

const logger = getLogger(["tempo", "run"]);

export async function runCustom(
	config: ResolvedConfig,
	name: string,
	args: string[],
): Promise<number> {
	const custom = config.custom ?? {};

	if (name === "--list" || name === "-l") {
		if (Object.keys(custom).length === 0) {
			logger.info("no custom commands registered");
			return 0;
		}
		process.stdout.write(`${c.bold("Custom commands:")}\n\n`);
		for (const [cmdName, entry] of Object.entries(custom)) {
			const description = await getEntryDescription(entry, config.rootDir);
			if (description) {
				process.stdout.write(
					`  ${cmdName} ${c.overlay0("—")} ${description}\n`,
				);
			} else if (typeof entry === "string") {
				process.stdout.write(`  ${cmdName} ${c.overlay0(entry)}\n`);
			} else {
				process.stdout.write(`  ${cmdName} ${c.overlay0("(inline)")}\n`);
			}
		}
		return 0;
	}

	const entry: CustomCommandEntry | undefined = custom[name];
	if (!entry) {
		const available = Object.keys(custom);
		if (available.length === 0) {
			logger.error(
				'unknown command: "{name}". No custom commands registered.',
				{ name },
			);
		} else {
			logger.error('unknown command: "{name}". Available: {available}', {
				name,
				available: available.join(", "),
			});
		}
		return 1;
	}

	// Bare function — call with empty flags
	if (typeof entry === "function") {
		const group = new ProcessGroup({ signal: "natural" });
		try {
			return await entry({
				group,
				config,
				flags: {} as Record<never, never>,
				args,
				run,
				runPiped,
				fmt,
			});
		} finally {
			group.dispose();
		}
	}

	// Inline CommandSpec object — parse flags if defined
	if (typeof entry === "object") {
		return executeSpec(entry, config, args);
	}

	// String path — import file and execute
	return executeFilePath(entry, config, args);
}

async function executeFilePath(
	scriptPath: string,
	config: ResolvedConfig,
	args: string[],
): Promise<number> {
	const fullPath = resolve(config.rootDir, scriptPath);

	let mod: Record<string, unknown>;
	try {
		mod = await import(fullPath);
	} catch (err) {
		logger.error("failed to import {path}: {error}", {
			path: scriptPath,
			error: String(err),
		});
		return 1;
	}

	const command = mod.default as CommandSpec | undefined;
	if (!command || typeof command.run !== "function") {
		logger.error(
			"invalid command {path}: default export must be a defineCommand result",
			{ path: scriptPath },
		);
		return 1;
	}

	return executeSpec(command, config, args);
}

async function executeSpec(
	spec: InlineCommandSpec,
	config: ResolvedConfig,
	args: string[],
): Promise<number> {
	const { flags, positional } = spec.flags
		? parseFlagsFromArgv(spec.flags as Record<string, CommandFlagDef>, args)
		: { flags: {}, positional: args };

	const group = new ProcessGroup({ signal: "natural" });

	try {
		return await spec.run({
			group,
			config,
			flags: flags as any,
			args: positional,
			run,
			runPiped,
			fmt,
		});
	} finally {
		group.dispose();
	}
}

async function getEntryDescription(
	entry: CustomCommandEntry,
	rootDir: string,
): Promise<string> {
	if (typeof entry === "function") {
		return "";
	}

	if (typeof entry === "object") {
		return entry.description ?? "";
	}

	// String path — import to extract description
	const fullPath = resolve(rootDir, entry);
	try {
		const mod = await import(fullPath);
		const spec = mod.default as CommandSpec | undefined;
		if (spec?.description) return spec.description;
	} catch {
		// can't load — caller shows path as fallback
	}
	return "";
}
