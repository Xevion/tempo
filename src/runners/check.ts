import { getLogger } from "@logtape/logtape";
import { TempoAbortError } from "../errors.ts";
import { elapsed, isInteractive } from "../fmt.ts";
import { buildHookContext, runCleanups, tryHook } from "../hooks.ts";
import { drainAsCompleted } from "../proc.ts";
import { resolveCommandDef } from "../resolve.ts";
import { resolveAndLogTargets } from "../targets.ts";
import { checkMissingTools } from "../tools.ts";
import type {
	CheckInfo,
	CollectResult,
	HookContext,
	ResolvedConfig,
	SkippedCheck,
} from "../types.ts";
import { runFixFirst, runFixOnFail } from "./check-autofix.ts";
import { runPreflights } from "./check-preflight.ts";
import {
	createSpinner,
	isFailure,
	renderResult,
	renderSkipped,
	renderSummary,
} from "./check-renderer.ts";
import { type CheckEntry, spawnChecks } from "./check-spawn.ts";

const logger = getLogger(["tempo", "check"]);

/** Render all skipped checks via custom renderer or default */
function renderSkippedChecks(
	skipped: SkippedCheck[],
	config: ResolvedConfig,
): void {
	const renderer = config.check?.renderer;
	for (const skip of skipped) {
		if (renderer) {
			renderer({ type: "check-skip", name: skip.name, skipped: skip });
		} else {
			renderSkipped(skip, config);
		}
	}
}

/** Build hints map from missing tool requirements */
function buildHintsMap(
	missing: { tool: string; hint?: string }[],
): Map<string, string> {
	const hints = new Map<string, string>();
	for (const req of missing) {
		if (req.hint) hints.set(req.tool, req.hint);
	}
	return hints;
}

/** Build the list of checks to run from targeted subsystems */
function buildCheckList(
	subsystems: Set<string>,
	config: ResolvedConfig,
): { checks: CheckEntry[]; skipped: SkippedCheck[] } {
	const checks: CheckEntry[] = [];
	const skipped: SkippedCheck[] = [];
	const excluded: Set<string> = new Set(config.check?.exclude ?? []);

	for (const subsystem of subsystems) {
		const sub = config.subsystems[subsystem];
		if (!sub?.commands) continue;
		for (const [action, def] of Object.entries(sub.commands)) {
			const checkName = `${subsystem}:${action}`;
			if (excluded.has(checkName)) continue;
			const missing = checkMissingTools(sub.requires, def);
			if (missing) {
				skipped.push({
					name: checkName,
					missing: missing.map((r) => r.tool),
					hints: buildHintsMap(missing),
				});
				logger.warn("skip {name} (missing: {tools})", {
					name: checkName,
					tools: missing.map((r) => r.tool).join(", "),
				});
				continue;
			}

			checks.push({
				name: checkName,
				subsystem,
				action,
				def,
			});
		}
	}

	return { checks, skipped };
}

/** Build env overrides from hook env, TTY settings, and CI injection */
function buildEnvOverrides(
	hookEnv: Record<string, string>,
	config: ResolvedConfig,
): Record<string, string> {
	const env: Record<string, string> = { ...hookEnv };
	if (config.json) {
		env.NO_COLOR = "1";
	} else if (isInteractive(config)) {
		env.FORCE_COLOR = "1";
		env.CLICOLOR_FORCE = "1";
	}
	if (config.isCI && config.ci?.inject) {
		Object.assign(env, config.ci.inject);
	}
	return env;
}

/** Fire before:check:each hooks for all checks */
async function fireBeforeEachHooks(
	checks: CheckEntry[],
	config: ResolvedConfig,
	hookCtx: HookContext,
): Promise<void> {
	const hook = config.hooks?.["before:check:each"];
	if (!hook) return;
	for (const check of checks) {
		const { cmd } = resolveCommandDef(check.def);
		const info: CheckInfo = {
			name: check.name,
			subsystem: check.subsystem,
			action: check.action,
			cmd,
		};
		await hook(hookCtx, info);
	}
}

/** Collect results from spawned checks, rendering and dispatching after:check:each hooks */
async function collectResults(
	checks: CheckEntry[],
	config: ResolvedConfig,
	envOverrides: Record<string, string>,
	startTime: number,
	hookCtx: HookContext,
	spinner: ReturnType<typeof createSpinner>,
): Promise<{ results: Map<string, CollectResult>; hasFailure: boolean }> {
	const { promises, fallbacks } = spawnChecks(
		checks,
		config,
		envOverrides,
		startTime,
	);

	const results = new Map<string, CollectResult>();
	let hasFailure = false;
	const renderer = config.check?.renderer;

	await drainAsCompleted(promises, fallbacks, (result) => {
		spinner.removeCheck(result.name);
		results.set(result.name, result);

		const check = checks.find((ch) => ch.name === result.name);
		if (!check) return;

		if (renderer) {
			renderer({ type: "check-complete", name: result.name, result });
		} else {
			renderResult(result, check.def, config);
		}

		if (isFailure(result, check.def, config)) {
			hasFailure = true;
		}

		if (config.hooks?.["after:check:each"]) {
			const info: CheckInfo = {
				name: check.name,
				subsystem: check.subsystem,
				action: check.action,
				cmd: [],
			};
			config.hooks["after:check:each"](hookCtx, info, result);
		}
	});

	return { results, hasFailure };
}

export async function runCheck(
	config: ResolvedConfig,
	args: string[],
	flags: Record<string, unknown>,
): Promise<number> {
	const targetResult = resolveAndLogTargets(args, config.subsystems, logger);

	for (const [name, sub] of Object.entries(config.subsystems)) {
		if (sub.alwaysRun) {
			targetResult.subsystems.add(name);
		}
	}

	const {
		hookCtx: baseHookCtx,
		cleanupFns,
		hookEnv,
	} = buildHookContext(config, flags, targetResult.subsystems);

	const startTime = Date.now();
	const { checks, skipped } = buildCheckList(targetResult.subsystems, config);
	const spinner = createSpinner(
		config,
		startTime,
		checks.map((ch) => ch.name),
	);

	renderSkippedChecks(skipped, config);

	try {
		await runPreflights(config, baseHookCtx.logger, baseHookCtx.fail, (label) =>
			spinner.setStatus(label),
		);
	} catch (e) {
		if (e instanceof TempoAbortError) {
			spinner.stop();
			return 1;
		}
		throw e;
	}

	if (checks.length === 0) {
		spinner.stop();
		logger.info("no checks to run");
		return 0;
	}

	const hookAbort = await tryHook(config.hooks?.["before:check"], baseHookCtx);
	if (hookAbort !== null) {
		spinner.stop();
		return hookAbort;
	}

	const envOverrides = buildEnvOverrides(hookEnv, config);

	if (flags.fix && config.check?.autoFixStrategy !== "fix-on-fail") {
		runFixFirst(checks, config, envOverrides, logger);
	}

	spinner.setPhase("checks");
	await fireBeforeEachHooks(checks, config, baseHookCtx);

	let { results, hasFailure } = await collectResults(
		checks,
		config,
		envOverrides,
		startTime,
		baseHookCtx,
		spinner,
	);

	spinner.stop();

	if (
		flags.fix &&
		config.check?.autoFixStrategy === "fix-on-fail" &&
		hasFailure
	) {
		hasFailure = await runFixOnFail(
			checks,
			results,
			config,
			envOverrides,
			logger,
		);
	}

	if (config.hooks?.["after:check"]) {
		await config.hooks["after:check"](baseHookCtx, results);
	}
	await runCleanups(cleanupFns);

	renderSummary(
		results,
		hasFailure,
		elapsed(startTime),
		config,
		skipped.length,
	);
	return hasFailure ? 1 : 0;
}
