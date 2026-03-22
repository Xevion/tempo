import { resolve } from "node:path";
import { getLogger } from "@logtape/logtape";
import { parseFlagsFromArgv } from "../flags";
import * as fmt from "../fmt";
import { c } from "../fmt";
import { ProcessGroup, run, runPiped } from "../proc";
import type { CommandFlagDef, CommandSpec, ResolvedConfig } from "../types";

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
		for (const [cmdName, cmdPath] of Object.entries(custom)) {
			const fullCmdPath = resolve(config.rootDir, cmdPath);
			let description = "";
			try {
				const mod = await import(fullCmdPath);
				const spec = mod.default as CommandSpec | undefined;
				if (spec?.description) description = spec.description;
			} catch {
				// can't load — show path as fallback
			}
			if (description) {
				process.stdout.write(
					`  ${cmdName} ${c.overlay0("—")} ${description}\n`,
				);
			} else {
				process.stdout.write(`  ${cmdName} ${c.overlay0(cmdPath)}\n`);
			}
		}
		return 0;
	}

	const scriptPath = custom[name];
	if (!scriptPath) {
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
			{
				path: scriptPath,
			},
		);
		return 1;
	}

	const { flags, positional } = command.flags
		? parseFlagsFromArgv(command.flags as Record<string, CommandFlagDef>, args)
		: { flags: {}, positional: args };

	const group = new ProcessGroup({ signal: "natural" });

	try {
		const exitCode = await command.run({
			group,
			config,
			flags: flags as any,
			args: positional,
			run,
			runPiped,
			fmt,
		});
		return exitCode;
	} finally {
		group.dispose();
	}
}
