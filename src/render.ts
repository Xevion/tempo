import type { EngineEvent, EventSink, Outcome } from "./engine/types.ts";
import { c } from "./utils/theme.ts";

/** Raw record stream, one JSON object per line. */
export function jsonSink(): EventSink {
	return (event) => {
		process.stdout.write(`${JSON.stringify(event)}\n`);
	};
}

function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function describe(outcome: Outcome): { mark: string; note: string } {
	switch (outcome.kind) {
		case "ok":
			return { mark: c.green("✓"), note: c.dim(`(${seconds(outcome.ms)})`) };
		case "fail":
			return {
				mark: c.red("✗"),
				note: c.dim(`(${seconds(outcome.ms)}, exit ${outcome.code})`),
			};
		case "skip":
			return { mark: c.yellow("⊘"), note: c.dim(`(${outcome.reason})`) };
		case "blocked":
			return { mark: c.yellow("·"), note: c.dim(`(blocked by ${outcome.by})`) };
		case "cancelled":
			return { mark: c.dim("⨯"), note: c.dim("(cancelled)") };
	}
}

/** Replay a failed task's buffered output beneath its row. */
function renderFailure(
	outcome: Extract<Outcome, { kind: "fail" }>,
	lines: string[],
	write: (line: string) => void,
): void {
	for (const line of lines) write(`  ${c.dim(line)}`);
	if (outcome.error) write(`  ${c.red(outcome.error)}`);
}

function renderSummary(
	outcomes: Map<string, Outcome>,
	ok: boolean,
	ms: number,
	write: (line: string) => void,
): void {
	const passed = [...outcomes.values()].filter((o) => o.kind === "ok").length;
	const label = `${passed}/${outcomes.size} passed`;
	write("");
	write(`${ok ? c.green(label) : c.red(label)} ${c.dim(`(${seconds(ms)})`)}`);
}

/**
 * Human-readable rendering, written to stderr so stdout stays a clean data
 * channel. Child output is buffered and replayed only for failures, which is
 * what keeps a parallel run readable.
 */
export function ttySink(): EventSink {
	const buffered = new Map<string, string[]>();
	const outcomes = new Map<string, Outcome>();
	const write = (line: string) => process.stderr.write(`${line}\n`);

	return (event: EngineEvent) => {
		if (event.type === "task-output") {
			const lines = buffered.get(event.task) ?? [];
			lines.push(event.line);
			buffered.set(event.task, lines);
			return;
		}
		if (event.type === "task-log") {
			write(`${c.dim("│")} ${event.task}: ${event.message}`);
			return;
		}
		if (event.type === "task-ready") {
			write(`${c.green("●")} ${event.task} ${c.dim("ready")}`);
			return;
		}
		if (event.type === "task-settled") {
			outcomes.set(event.task, event.outcome);
			const { mark, note } = describe(event.outcome);
			write(`${mark} ${event.task} ${note}`);
			if (event.outcome.kind === "fail") {
				renderFailure(event.outcome, buffered.get(event.task) ?? [], write);
			}
			return;
		}
		if (event.type === "run-end") {
			renderSummary(outcomes, event.ok, event.ms, write);
		}
	};
}
