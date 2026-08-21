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
		case "cached":
			return { mark: c.green("✓"), note: c.dim("(cached)") };
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
	const passed = [...outcomes.values()].filter(
		(o) => o.kind === "ok" || o.kind === "cached",
	).length;
	const label = `${passed}/${outcomes.size} passed`;
	write("");
	write(`${ok ? c.green(label) : c.red(label)} ${c.dim(`(${seconds(ms)})`)}`);
}

/**
 * Human-readable rendering, written to stderr so stdout stays a clean data
 * channel. Child output is buffered and replayed only for failures, which is
 * what keeps a parallel run readable.
 */
/** Stable per-task colour so a multiplexed pane stays readable. */
const PREFIX_COLORS = [
	c.blue,
	c.green,
	c.yellow,
	c.magenta,
	c.cyan,
	c.red,
] as const;

function prefixFor(task: string, order: Map<string, number>): string {
	if (!order.has(task)) order.set(task, order.size);
	const paint = PREFIX_COLORS[(order.get(task) ?? 0) % PREFIX_COLORS.length];
	return `${(paint ?? c.blue)(task)} ${c.dim("│")}`;
}

/**
 * Human-readable rendering, written to stderr so stdout stays a clean data
 * channel.
 *
 * A one-shot task buffers its output and replays it only on failure, which is
 * what keeps a parallel check readable. A persistent task streams live behind a
 * source prefix, because its output is the point.
 */
interface TtyState {
	buffered: Map<string, string[]>;
	outcomes: Map<string, Outcome>;
	live: Set<string>;
	order: Map<string, number>;
	write: (line: string) => void;
}

function handleOutput(task: string, line: string, state: TtyState): void {
	if (state.live.has(task)) {
		state.write(`${prefixFor(task, state.order)} ${line}`);
		return;
	}
	const lines = state.buffered.get(task) ?? [];
	lines.push(line);
	state.buffered.set(task, lines);
}

function handleSettled(task: string, outcome: Outcome, state: TtyState): void {
	state.outcomes.set(task, outcome);
	const { mark, note } = describe(outcome);
	state.write(`${mark} ${task} ${note}`);
	if (outcome.kind === "fail") {
		renderFailure(outcome, state.buffered.get(task) ?? [], state.write);
	}
	state.buffered.delete(task);
}

/**
 * Human-readable rendering, written to stderr so stdout stays a clean data
 * channel.
 *
 * A one-shot task buffers its output and replays it only on failure, which is
 * what keeps a parallel check readable. A persistent task streams live behind a
 * source prefix, because its output is the point.
 */
export function ttySink(): EventSink {
	const state: TtyState = {
		buffered: new Map(),
		outcomes: new Map(),
		live: new Set(),
		order: new Map(),
		write: (line) => process.stderr.write(`${line}\n`),
	};

	return (event: EngineEvent) => {
		switch (event.type) {
			case "task-start":
				if (event.persistent) state.live.add(event.task);
				return;
			case "task-output":
				handleOutput(event.task, event.line, state);
				return;
			case "task-log":
				state.write(`${c.dim("│")} ${event.task}: ${event.message}`);
				return;
			case "task-restart":
				state.write(
					`${c.yellow("↻")} ${event.task} ${c.dim(`(${event.reason})`)}`,
				);
				return;
			case "task-ready":
				state.write(`${c.green("●")} ${event.task} ${c.dim("ready")}`);
				return;
			case "task-settled":
				handleSettled(event.task, event.outcome, state);
				return;
			case "run-end":
				renderSummary(state.outcomes, event.ok, event.ms, state.write);
				return;
			default:
				return;
		}
	};
}
