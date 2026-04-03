export {
	formatDuration,
	formatTokens,
	termWidth,
	wordWrap,
} from "./utils/format.ts";
export { c } from "./utils/theme.ts";

export function elapsed(start: number): string {
	return ((Date.now() - start) / 1000).toFixed(1);
}

export function parseArgs(raw: string): string[] {
	return raw.trim().split(/\s+/).filter(Boolean);
}

export const isStderrTTY: boolean = process.stderr.isTTY ?? false;

/** Whether we're in an interactive TTY (not CI) — controls spinner, color routing, etc. */
export function isInteractive(config: { isCI: boolean }): boolean {
	return isStderrTTY && !config.isCI;
}

export const EXIT_SIGINT = 130; // 128 + SIGINT(2)
export const EXIT_SIGTERM = 143; // 128 + SIGTERM(15)

/** Map a signal name to its conventional exit code */
export function exitCodeForSignal(signal: NodeJS.Signals): number {
	return signal === "SIGINT" ? EXIT_SIGINT : EXIT_SIGTERM;
}

/** Carriage return + erase to end of line — clears a spinner/status line */
export const CLEAR_LINE = "\r\x1b[K";
/** Reset attributes, show cursor, exit alt screen — restores terminal after crash */
export const RESET_TERMINAL = "\x1b[0m\x1b[?25h\x1b[?1049l";
