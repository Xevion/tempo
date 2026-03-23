export {
	formatDuration,
	formatTokens,
	termWidth,
	wordWrap,
} from "./utils/format.ts";
export { c, strip } from "./utils/theme.ts";

export function elapsed(start: number): string {
	return ((Date.now() - start) / 1000).toFixed(1);
}

export function parseArgs(raw: string): string[] {
	return raw.trim().split(/\s+/).filter(Boolean);
}

export const isStderrTTY: boolean = process.stderr.isTTY ?? false;

export const isTTY: boolean = process.stdout.isTTY ?? false;
