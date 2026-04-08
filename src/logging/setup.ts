import { getFileSink } from "@logtape/file";
import { configure, type LogLevel, reset, type Sink } from "@logtape/logtape";
import { getJsonStdoutSink } from "./json.ts";
import { getColoredStderrSink } from "./sink.ts";

export interface LoggingOptions {
	verbosity: number;
	quiet: boolean;
	json?: boolean;
	logFile?: string;
}

function resolveLevel(opts: LoggingOptions): LogLevel {
	if (opts.quiet) return "error";
	if (opts.verbosity >= 2) return "trace";
	if (opts.verbosity >= 1) return "debug";
	return "info";
}

export async function setupLogging(opts: LoggingOptions): Promise<void> {
	const level = resolveLevel(opts);

	const sinks: Record<string, Sink> = {};
	const sinkNames: string[] = [];

	if (!opts.quiet) {
		sinks.console = opts.json ? getJsonStdoutSink() : getColoredStderrSink();
		sinkNames.push("console");
	}

	if (opts.logFile) {
		const { jsonLinesFormatter } = await import("@logtape/logtape");
		sinks.file = getFileSink(opts.logFile, {
			formatter: jsonLinesFormatter,
		});
		sinkNames.push("file");
	}

	await configure({
		sinks,
		loggers: [
			{
				category: "tempo",
				lowestLevel: level,
				sinks: sinkNames,
			},
			{
				category: ["logtape", "meta"],
				lowestLevel: "warning",
				sinks: sinkNames,
			},
		],
	});
}

export async function teardownLogging(): Promise<void> {
	await reset();
}
