import { getLogger } from "@logtape/logtape";
import { TempoConfigError } from "../errors.ts";
import { lockFileFor } from "../lock.ts";
import { emitJson, nowIso, type OutputJsonRecord } from "../logging/json.ts";
import { run, runPiped } from "../proc.ts";
import {
	appendPassthrough,
	resolveCommandDef,
	resolveCwd,
} from "../resolve.ts";
import { resolveAndLogTargets } from "../targets.ts";
import { checkMissingTools } from "../tools.ts";
import type { CommandDef, ResolvedConfig } from "../types.ts";

/** Shared runner for sequential command execution (fmt, lint) */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: sequential runner with fallback resolution
export async function runSequential(
	config: ResolvedConfig,
	args: string[],
	passthrough: string[],
	opts: {
		commandKey: string;
		loggerName: string;
		autoFixFallback?: boolean;
	},
): Promise<number> {
	const logger = getLogger(["tempo", opts.loggerName]);
	const targetResult = resolveAndLogTargets(args, config.subsystems, logger);
	let ran = 0;

	for (const subsystem of targetResult.subsystems) {
		const sub = config.subsystems[subsystem];
		if (!sub?.commands) continue;

		let def: CommandDef | undefined = sub.commands[opts.commandKey];
		if (!def && opts.autoFixFallback && sub.autoFix) {
			for (const fixAction of Object.values(sub.autoFix)) {
				if (fixAction && sub.commands[fixAction]) {
					def = sub.commands[fixAction];
					break;
				}
			}
		}

		if (!def) continue;

		const missing = checkMissingTools(sub.requires, def);
		if (missing) {
			logger.warn("skip {subsystem} (missing: {tools})", {
				subsystem,
				tools: missing.map((r) => r.tool).join(", "),
			});
			continue;
		}

		const { cmd, opts: cmdOpts } = resolveCommandDef(def);
		const cwd = resolveCwd(config.rootDir, cmdOpts.cwd, sub.cwd);
		const finalCmd = appendPassthrough(cmd, passthrough);
		const lock = lockFileFor(config.rootDir, sub.lock, cmdOpts.lock);

		ran++;

		if (config.json) {
			const result = runPiped(finalCmd, { cwd, lock });
			const ts = nowIso();
			for (const stream of ["stdout", "stderr"] as const) {
				for (const line of result[stream].split("\n")) {
					if (!line) continue;
					const record: OutputJsonRecord = {
						ts,
						type: "output",
						name: subsystem,
						stream,
						line,
					};
					emitJson(record);
				}
			}
			if (result.exitCode !== 0) {
				return result.exitCode;
			}
		} else {
			run(finalCmd, { cwd, lock });
		}
	}

	// A key matching no subsystem is a config error, not an empty workload.
	if (ran === 0) {
		throw new TempoConfigError(
			`no subsystem defines a "${opts.commandKey}" command`,
		);
	}

	return 0;
}
