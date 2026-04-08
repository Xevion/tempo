import {
	CLEAR_LINE,
	c,
	EXIT_SIGINT,
	EXIT_SIGTERM,
	elapsed,
	isInteractive,
} from "../fmt.ts";
import {
	emitJson,
	nowIso,
	type ResultJsonRecord,
	type SkipJsonRecord,
	type SummaryJsonRecord,
} from "../logging/json.ts";
import { resolveCommandDef } from "../resolve.ts";
import type {
	CheckRenderEvent,
	CollectResult,
	CommandDef,
	ResolvedConfig,
	SkippedCheck,
} from "../types.ts";

/** Whether a process was killed by a signal (exit code 128+signal) */
function isSignalKilled(exitCode: number): boolean {
	return exitCode === EXIT_SIGINT || exitCode === EXIT_SIGTERM;
}

/** Determine if a result is a failure, considering warnIfExitCode and signal kills */
export function isFailure(
	result: CollectResult,
	def: CommandDef,
	config: ResolvedConfig,
): boolean {
	if (result.exitCode === 0) return false;
	if (isSignalKilled(result.exitCode)) return false;
	const checkOpts =
		config.check?.options?.[result.name as `${string}:${string}`];
	const { opts } = resolveCommandDef(def);
	const warnCode = opts.warnIfExitCode ?? checkOpts?.warnIfExitCode;
	return warnCode === undefined || result.exitCode !== warnCode;
}

/** Render a single check result to stdout/stderr */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: rendering logic with many output branches
export function renderResult(
	result: CollectResult,
	def: CommandDef,
	config: ResolvedConfig,
): void {
	if (config.json) {
		const record: ResultJsonRecord = {
			ts: nowIso(),
			type: "result",
			name: result.name,
			exitCode: result.exitCode,
			elapsed: result.elapsed,
			stdout: result.stdout,
			stderr: result.stderr,
		};
		emitJson(record);
		return;
	}

	const checkOpts =
		config.check?.options?.[result.name as `${string}:${string}`];
	const { opts } = resolveCommandDef(def);
	const warnCode = opts.warnIfExitCode ?? checkOpts?.warnIfExitCode;
	const toTTY = isInteractive(config);
	const out = toTTY ? process.stderr : process.stdout;

	if (toTTY) {
		process.stderr.write(CLEAR_LINE);
	}

	if (config.isCI && config.ci?.groupedOutput) {
		process.stdout.write(`::group::${result.name}\n`);
	}

	if (result.exitCode === 0) {
		out.write(
			`${c.catGreen("✓")} ${result.name} ${c.overlay0(`(${result.elapsed}s)`)}\n`,
		);
	} else if (isSignalKilled(result.exitCode)) {
		out.write(
			`${c.catYellow("⚡")} ${result.name} ${c.overlay0("interrupted")}\n`,
		);
	} else if (warnCode !== undefined && result.exitCode === warnCode) {
		out.write(
			`${c.catYellow("⚠")} ${result.name} ${c.overlay0(`(${result.elapsed}s)`)}\n`,
		);
	} else {
		out.write(
			`${c.catRed("✗")} ${result.name} ${c.overlay0(`(${result.elapsed}s)`)}\n`,
		);
		if (result.stdout.trim()) out.write(result.stdout);
		if (result.stderr.trim()) process.stderr.write(result.stderr);
	}

	if (config.isCI && config.ci?.groupedOutput) {
		process.stdout.write("::endgroup::\n");
	}
}

/** Render a skipped check (missing tools) */
export function renderSkipped(
	skip: SkippedCheck,
	config: ResolvedConfig,
): void {
	if (config.json) {
		const record: SkipJsonRecord = {
			ts: nowIso(),
			type: "skip",
			name: skip.name,
			missing: skip.missing,
		};
		emitJson(record);
		return;
	}

	const toTTY = isInteractive(config);
	const out = toTTY ? process.stderr : process.stdout;

	if (toTTY) {
		process.stderr.write(CLEAR_LINE);
	}

	out.write(
		`${c.catYellow("⊘")} ${skip.name} ${c.overlay0(`(skipped — missing: ${skip.missing.join(", ")})`)}\n`,
	);
	for (const [tool, hint] of skip.hints) {
		out.write(`  ${c.overlay0(`hint (${tool}):`)} ${hint}\n`);
	}
}

/** Render the final summary line */
export function renderSummary(
	results: Map<string, CollectResult>,
	hasFailure: boolean,
	totalElapsed: string,
	config: ResolvedConfig,
	skippedCount = 0,
): void {
	if (config.json) {
		const allResults = [...results.values()];
		const completed = allResults.filter((r) => !isSignalKilled(r.exitCode));
		const passed = completed.filter((r) => r.exitCode === 0).length;
		const record: SummaryJsonRecord = {
			ts: nowIso(),
			type: "summary",
			passed,
			total: completed.length,
			skippedCount,
			elapsed: totalElapsed,
			hasFailure,
		};
		emitJson(record);
		return;
	}

	const renderer = config.check?.renderer;
	if (renderer) {
		renderer({
			type: "summary",
			results,
			skippedCount,
		} as CheckRenderEvent);
		return;
	}

	const allResults = [...results.values()];
	const interrupted = allResults.filter((r) => isSignalKilled(r.exitCode));
	const completed = allResults.filter((r) => !isSignalKilled(r.exitCode));
	const passed = completed.filter((r) => r.exitCode === 0).length;
	const total = completed.length;
	const out = isInteractive(config) ? process.stderr : process.stdout;
	const skippedSuffix =
		skippedCount > 0 ? ` ${c.overlay0(`(${skippedCount} skipped)`)}` : "";

	if (interrupted.length > 0) {
		out.write(
			`\n${c.bold(c.catYellow(`${passed}/${total} passed`))} ${c.overlay0(`(${totalElapsed}s)`)} ${c.overlay0(`(${interrupted.length} interrupted)`)}${skippedSuffix}\n`,
		);
	} else if (hasFailure) {
		out.write(
			`\n${c.bold(c.catRed(`${passed}/${total} passed`))} ${c.overlay0(`(${totalElapsed}s)`)}${skippedSuffix}\n`,
		);
	} else {
		out.write(
			`\n${c.bold(c.catGreen(`${total}/${total} passed`))} ${c.overlay0(`(${totalElapsed}s)`)}${skippedSuffix}\n`,
		);
	}
}

export interface Spinner {
	setPhase(phase: "preflight" | "checks"): void;
	setStatus(status: string): void;
	removeCheck(name: string): void;
	stop(): void;
}

/** Create a TUI spinner for interactive TTY output, or a no-op if non-interactive */
export function createSpinner(
	config: ResolvedConfig,
	startTime: number,
	checkNames: string[],
): Spinner {
	const renderer = config.check?.renderer;
	if (renderer || config.json || !isInteractive(config)) {
		// No-op spinner for non-interactive or custom renderer
		return {
			setPhase() {},
			setStatus() {},
			removeCheck() {},
			stop() {},
		};
	}

	let phase: "preflight" | "checks" = "preflight";
	let status = "preflight";
	const remaining = new Set(checkNames);

	const interval = setInterval(() => {
		const el = elapsed(startTime);
		const cols = process.stderr.columns || 80;
		let text: string;
		if (phase === "preflight") {
			text = `${el}s ${status}`;
		} else if (remaining.size > 0) {
			text = `${el}s ${[...remaining].join(", ")}`;
		} else {
			return;
		}
		if (text.length > cols) {
			text = `${text.slice(0, cols - 1)}\u2026`;
		}
		process.stderr.write(`${CLEAR_LINE}${c.overlay0(text)}`);
	}, 100);

	return {
		setPhase(p) {
			phase = p;
		},
		setStatus(s) {
			status = s;
		},
		removeCheck(name) {
			remaining.delete(name);
		},
		stop() {
			clearInterval(interval);
			if (isInteractive(config)) process.stderr.write(CLEAR_LINE);
		},
	};
}
