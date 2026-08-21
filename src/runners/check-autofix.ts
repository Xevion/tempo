import type { Logger } from "@logtape/logtape";
import { TempoRunError } from "../errors.ts";
import { c, isInteractive } from "../fmt.ts";
import { lockFileFor } from "../lock.ts";
import type { ProcessGroup } from "../proc.ts";
import { drainAsCompleted, run } from "../proc.ts";
import { resolveCommandDef, resolveCwd } from "../resolve.ts";
import { checkMissingTools } from "../tools.ts";
import type { CollectResult, ResolvedConfig } from "../types.ts";
import { isFailure } from "./check-renderer.ts";
import { type CheckEntry, spawnChecks } from "./check-spawn.ts";

/** Apply a single auto-fix action for a subsystem. Returns true on success, false if the fix failed or was skipped. */
function applyFix(
	subsystem: string,
	fixAction: string,
	config: ResolvedConfig,
	envOverrides: Record<string, string>,
	logger: Logger,
): boolean {
	const sub = config.subsystems[subsystem];
	if (!sub?.commands) return false;
	const fixDef = sub.commands[fixAction];
	if (!fixDef) return false;
	if (checkMissingTools(sub.requires, fixDef)) return false;
	const { cmd, opts } = resolveCommandDef(fixDef);
	logger.info("fix {target}", { target: `${subsystem}:${fixAction}` });
	try {
		run(cmd, {
			cwd: resolveCwd(config.rootDir, undefined, sub.cwd),
			env: envOverrides,
			lock: lockFileFor(config.rootDir, sub.lock, opts.lock),
		});
		return true;
	} catch (err) {
		if (err instanceof TempoRunError) {
			logger.error("fix {target} failed (exit {code})", {
				target: `${subsystem}:${fixAction}`,
				code: err.exitCode,
			});
			return false;
		}
		throw err;
	}
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

/** Attempt a single fix for a failed check. Returns the check if the fix ran
 *  successfully (and should be re-verified), or null if there was no fix, it
 *  was skipped, or the fix command itself failed. */
function tryFixFailedCheck(
	check: CheckEntry,
	results: Map<string, CollectResult>,
	config: ResolvedConfig,
	envOverrides: Record<string, string>,
	logger: Logger,
): CheckEntry | null {
	const sub = config.subsystems[check.subsystem];
	if (!sub?.autoFix || !sub.commands) return null;

	const fixAction = sub.autoFix[check.action];
	if (!fixAction) return null;

	const fixDef = sub.commands[fixAction];
	if (!fixDef) return null;

	const { cmd, opts } = resolveCommandDef(fixDef);
	logger.info("fix {target}", { target: `${check.subsystem}:${fixAction}` });
	try {
		run(cmd, {
			cwd: resolveCwd(config.rootDir, undefined, sub.cwd),
			env: envOverrides,
			lock: lockFileFor(config.rootDir, sub.lock, opts.lock),
		});
		return check;
	} catch (err) {
		if (!(err instanceof TempoRunError)) throw err;
		logger.error("fix {target} failed (exit {code})", {
			target: `${check.subsystem}:${fixAction}`,
			code: err.exitCode,
		});
		const prior = results.get(check.name);
		if (prior) {
			results.set(check.name, {
				...prior,
				stderr: `${prior.stderr}\n\nfix '${fixAction}' failed with exit code ${err.exitCode}`,
			});
		}
		return null;
	}
}

/**
 * Whether any check still counts as failed, across every result rather than only
 * the re-verified ones. A failure with no autoFix mapping must keep the run red.
 */
function anyFailure(
	checks: CheckEntry[],
	results: Map<string, CollectResult>,
	config: ResolvedConfig,
): boolean {
	for (const [name, result] of results) {
		const check = checks.find((ch) => ch.name === name);
		if (!check) {
			if (result.exitCode !== 0) return true;
			continue;
		}
		if (isFailure(result, check.def, config)) return true;
	}
	return false;
}

/** Run fix-on-fail auto-fix: apply fixes only for failed checks, then re-verify */
export async function runFixOnFail(
	checks: CheckEntry[],
	results: Map<string, CollectResult>,
	config: ResolvedConfig,
	envOverrides: Record<string, string>,
	logger: Logger,
	group?: ProcessGroup,
): Promise<boolean> {
	const fixedChecks: CheckEntry[] = [];

	for (const [name, result] of results) {
		if (result.exitCode === 0) continue;
		const check = checks.find((ch) => ch.name === name);
		if (!check) continue;
		const fixed = tryFixFailedCheck(
			check,
			results,
			config,
			envOverrides,
			logger,
		);
		if (fixed) fixedChecks.push(fixed);
	}

	if (fixedChecks.length === 0) return anyFailure(checks, results, config);

	// Re-verify fixed checks
	logger.info("re-verifying fixed checks...");
	const { promises: rePromises, fallbacks: reFallbacks } = spawnChecks(
		fixedChecks,
		config,
		envOverrides,
		{ group },
	);

	await drainAsCompleted(rePromises, reFallbacks, (result) => {
		results.set(result.name, result);
		renderReVerifyResult(result, config, logger);
	});

	return anyFailure(checks, results, config);
}

function renderReVerifyResult(
	result: CollectResult,
	config: ResolvedConfig,
	logger: Logger,
): void {
	const passed = result.exitCode === 0;
	if (config.json) {
		const msg = passed
			? "fix verified {name} ({elapsed}s)"
			: "fix still failing {name} ({elapsed}s)";
		const props = { name: result.name, elapsed: result.elapsed };
		if (passed) logger.info(msg, props);
		else logger.error(msg, props);
		return;
	}
	const out = isInteractive(config) ? process.stderr : process.stdout;
	const mark = passed ? c.catGreen("✓") : c.catRed("✗");
	const label = passed ? "(fixed)" : "(still failing)";
	out.write(
		`${mark} ${result.name} ${c.overlay0(label)} ${c.overlay0(`(${result.elapsed}s)`)}\n`,
	);
}
