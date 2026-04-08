import { getLogger } from "@logtape/logtape";
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
				tools: missing.join(", "),
			});
			continue;
		}

		const { cmd, opts: cmdOpts } = resolveCommandDef(def);
		const cwd = resolveCwd(config.rootDir, cmdOpts.cwd, sub.cwd);
		const finalCmd = appendPassthrough(cmd, passthrough);

		if (config.json) {
			const result = runPiped(finalCmd, { cwd });
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
			run(finalCmd, { cwd });
		}
	}

	return 0;
}
