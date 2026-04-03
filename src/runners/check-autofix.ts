import type { Logger } from "@logtape/logtape";
import { c, isStderrTTY } from "../fmt.ts";
import {
	collectRequires,
	getMissingTools,
	raceInOrder,
	resolveCommandDef,
	resolveCwd,
	run,
} from "../proc.ts";
import type { CollectResult, CommandDef, ResolvedConfig } from "../types.ts";
import { type CheckEntry, spawnChecks } from "./check-spawn.ts";

/** Run fix-first auto-fix: apply fixes before checks run */
export function runFixFirst(
	checks: CheckEntry[],
	config: ResolvedConfig,
	envOverrides: Record<string, string>,
	logger: Logger,
): void {
	const subsystemsSeen = new Set<string>();

	for (const check of checks) {
		if (subsystemsSeen.has(check.subsystem)) continue;
		subsystemsSeen.add(check.subsystem);

		const sub = config.subsystems[check.subsystem];
		if (!sub?.autoFix || !sub.commands) continue;

		for (const [_checkAction, fixAction] of Object.entries(sub.autoFix)) {
			const fixDef = sub.commands[fixAction as string];
			if (!fixDef) continue;
			const fixRequires = collectRequires(sub.requires, fixDef as CommandDef);
			if (fixRequires.length > 0 && getMissingTools(fixRequires).length > 0)
				continue;
			const { cmd } = resolveCommandDef(fixDef as CommandDef);
			logger.info("fix {target}", {
				target: `${check.subsystem}:${fixAction}`,
			});
			run(cmd, {
				cwd: resolveCwd(config.rootDir, undefined, sub.cwd),
				env: envOverrides,
			});
		}
	}
}

/** Run fix-on-fail auto-fix: apply fixes only for failed checks, then re-verify */
export async function runFixOnFail(
	checks: CheckEntry[],
	results: Map<string, CollectResult>,
	config: ResolvedConfig,
	envOverrides: Record<string, string>,
	logger: Logger,
): Promise<boolean> {
	const fixedChecks: CheckEntry[] = [];

	for (const [name, result] of results) {
		if (result.exitCode === 0) continue;
		const check = checks.find((ch) => ch.name === name);
		if (!check) continue;

		const sub = config.subsystems[check.subsystem];
		if (!sub?.autoFix || !sub.commands) continue;

		const fixAction = sub.autoFix[check.action];
		if (!fixAction) continue;

		const fixDef = sub.commands[fixAction];
		if (!fixDef) continue;

		const { cmd } = resolveCommandDef(fixDef as CommandDef);
		logger.info("fix {target}", {
			target: `${check.subsystem}:${fixAction}`,
		});
		run(cmd, {
			cwd: resolveCwd(config.rootDir, undefined, sub.cwd),
			env: envOverrides,
		});
		fixedChecks.push(check);
	}

	if (fixedChecks.length === 0) return true;

	// Re-verify fixed checks
	logger.info("re-verifying fixed checks...");
	const reStartTime = Date.now();
	const { promises: rePromises, fallbacks: reFallbacks } = spawnChecks(
		fixedChecks,
		config,
		envOverrides,
		reStartTime,
	);

	let hasFailure = false;
	await raceInOrder(rePromises, reFallbacks, (result) => {
		results.set(result.name, result);
		const out = isStderrTTY && !config.isCI ? process.stderr : process.stdout;
		if (result.exitCode === 0) {
			out.write(
				`${c.catGreen("✓")} ${result.name} ${c.overlay0("(fixed)")} ${c.overlay0(`(${result.elapsed}s)`)}\n`,
			);
		} else {
			hasFailure = true;
			out.write(
				`${c.catRed("✗")} ${result.name} ${c.overlay0("(still failing)")} ${c.overlay0(`(${result.elapsed}s)`)}\n`,
			);
		}
	});

	return hasFailure;
}
