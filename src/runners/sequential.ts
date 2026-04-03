import { getLogger } from "@logtape/logtape";
import { run } from "../proc.ts";
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

		run(finalCmd, { cwd });
	}

	return 0;
}
