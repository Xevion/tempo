import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { inspect } from "node:util";
import type { LogRecord, Sink } from "@logtape/logtape";

export interface LogJsonRecord {
	ts: string;
	type: "log";
	level: string;
	logger: string;
	msg: string;
	[key: string]: unknown;
}

export interface OutputJsonRecord {
	ts: string;
	type: "output";
	name: string;
	stream: "stdout" | "stderr";
	line: string;
}

export interface ResultJsonRecord {
	ts: string;
	type: "result";
	name: string;
	exitCode: number;
	elapsed: string;
	stdout: string;
	stderr: string;
}

export interface SkipJsonRecord {
	ts: string;
	type: "skip";
	name: string;
	missing: string[];
}

export interface SummaryJsonRecord {
	ts: string;
	type: "summary";
	passed: number;
	total: number;
	skippedCount: number;
	elapsed: string;
	hasFailure: boolean;
}

export function nowIso(): string {
	return new Date().toISOString();
}

/** Write a JSON record as a single line to stdout */
export function emitJson(record: object): void {
	process.stdout.write(`${JSON.stringify(record)}\n`);
}

/** Flatten a LogTape message template array into a plain string */
function renderMessage(record: LogRecord): string {
	let msg = "";
	for (let i = 0; i < record.message.length; i++) {
		if (i % 2 === 0) {
			msg += record.message[i];
		} else {
			const value = record.message[i];
			msg +=
				typeof value === "string"
					? value
					: inspect(value, { colors: false, depth: 2, compact: true });
		}
	}
	return msg;
}

/**
 * A JSON Lines stdout sink for LogTape.
 *
 * Emits one JSON object per log record with the unified schema:
 * `{ ts, type: "log", level, logger, msg, ...properties }`
 */
export function getJsonStdoutSink(): Sink {
	const sink: Sink & Disposable = Object.assign(
		(record: LogRecord) => {
			const line: LogJsonRecord = {
				ts: new Date(record.timestamp).toISOString(),
				type: "log",
				level: record.level,
				logger: record.category.join("."),
				msg: renderMessage(record),
				...(record.properties as Record<string, unknown>),
			};
			emitJson(line);
		},
		{
			[Symbol.dispose]() {
				// no-op: process.stdout doesn't need explicit flushing
			},
		},
	);
	return sink;
}

/**
 * Attach readline-based line consumers to a child process's stdout/stderr.
 * Each line is emitted as a `type: "output"` JSON record to stdout.
 */
export function pipeJsonLines(proc: ChildProcess, name: string): void {
	for (const [stream, streamName] of [
		[proc.stdout, "stdout"],
		[proc.stderr, "stderr"],
	] as const) {
		if (!stream) continue;
		const rl = createInterface({
			input: stream,
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		rl.on("line", (line) => {
			const record: OutputJsonRecord = {
				ts: nowIso(),
				type: "output",
				name,
				stream: streamName,
				line,
			};
			emitJson(record);
		});
	}
}
