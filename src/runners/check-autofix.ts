import type { Logger } from "@logtape/logtape";
import { c, isInteractive } from "../fmt.ts";
import {
	checkMissingTools,
	raceInOrder,
	resolveCommandDef,
	resolveCwd,
	run,
} from "../proc.ts";
import type { CollectResult, ResolvedConfig } from "../types.ts";
import { type CheckEntry, spawnChecks } from "./check-spawn.ts";

/** Apply a single auto-fix action for a subsystem */
function applyFix(
	subsystem: string,
	fixAction: string,
	config: ResolvedConfig,
	envOverrides: Record<string, string>,
	logger: Logger,
): void {
	const sub = config.subsystems[subsystem];
	if (!sub?.commands) return;
	const fixDef = sub.commands[fixAction];
	if (!fixDef) return;
	if (checkMissingTools(sub.requires, fixDef)) return;
	const { cmd } = resolveCommandDef(fixDef);
	logger.info("fix {target}", { target: `${subsystem}:${fixAction}` });
	run(cmd, {
		cwd: resolveCwd(config.rootDir, undefined, sub.cwd),
		env: envOverrides,
	});
}

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
		if (!sub?.autoFix) continue;

		for (const [_checkAction, fixAction] of Object.entries(sub.autoFix)) {
			if (!fixAction) continue;
			applyFix(check.subsystem, fixAction, config, envOverrides, logger);
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

		const { cmd } = resolveCommandDef(fixDef);
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
		const out = isInteractive(config) ? process.stderr : process.stdout;
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
