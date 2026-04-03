import { inspect } from "node:util";
import type { LogRecord, Sink } from "@logtape/logtape";
import { c } from "../utils/theme.ts";

const LEVEL_WIDTH = 7;

function formatTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	const ss = String(date.getSeconds()).padStart(2, "0");
	const ms = String(date.getMilliseconds()).padStart(3, "0");
	return c.overlay0(`${hh}:${mm}:${ss}.${ms}`);
}

function formatLevel(level: string): string {
	const padded = level.toUpperCase().padEnd(LEVEL_WIDTH);
	switch (level) {
		case "trace":
			return c.overlay2(padded);
		case "debug":
			return c.catBlue(padded);
		case "info":
			return c.catGreen(padded);
		case "warning":
			return c.catYellow(padded);
		case "error":
			return c.catRed(padded);
		case "fatal":
			return c.bold(c.catRed(padded));
		default:
			return padded;
	}
}

function formatCategory(category: readonly string[]): string {
	if (category.length === 0) return "";
	const parts = category.map((part, i) =>
		i === 0 ? c.sapphire(part) : c.sky(part),
	);
	return parts.join(c.overlay0("·"));
}

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

function renderValue(value: unknown): string {
	if (value === null || value === undefined) return c.overlay1(String(value));
	if (typeof value === "string") return c.peach(value);
	if (typeof value === "number") return c.mauve(String(value));
	if (typeof value === "boolean")
		return value ? c.catGreen("true") : c.catRed("false");
	return c.overlay2(inspect(value, { colors: false, depth: 2, compact: true }));
}

function extractUsedKeys(rawMessage: string): Set<string> {
	const keys = new Set<string>();
	for (const m of rawMessage.matchAll(/\{(\w+)}/g)) {
		if (m[1]) keys.add(m[1]);
	}
	return keys;
}

function formatProperties(
	properties: Record<string, unknown>,
	usedKeys: Set<string>,
): string {
	const entries = Object.entries(properties).filter(
		([key]) => !usedKeys.has(key),
	);
	if (entries.length === 0) return "";
	const parts = entries.map(
		([key, value]) =>
			`${c.overlay1(key)}${c.overlay0("=")}${renderValue(value)}`,
	);
	return ` ${parts.join(" ")}`;
}

function formatRecord(record: LogRecord): string {
	const ts = formatTimestamp(record.timestamp);
	const level = formatLevel(record.level);
	const category = formatCategory(record.category);
	const message = renderMessage(record);
	const raw =
		typeof record.rawMessage === "string"
			? record.rawMessage
			: record.rawMessage.join("");
	const usedKeys = extractUsedKeys(raw);
	const props = formatProperties(
		record.properties as Record<string, unknown>,
		usedKeys,
	);
	return `${ts} ${level} ${category} ${c.text(message)}${props}\n`;
}

/**
 * A colorful stderr sink using the Catppuccin Mocha palette.
 *
 * Writes formatted log lines to stderr.
 */
export function getColoredStderrSink(): Sink {
	const sink: Sink & Disposable = Object.assign(
		(record: LogRecord) => {
			if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
			process.stderr.write(formatRecord(record));
		},
		{
			[Symbol.dispose]() {
				// no-op: process.stderr doesn't need explicit flushing
			},
		},
	);
	return sink;
}
