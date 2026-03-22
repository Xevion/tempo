export function formatDuration(seconds: number | null): string {
	if (seconds == null) return "—";
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	if (m < 60) return `${m}m${s > 0 ? ` ${s}s` : ""}`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	return `${h}h${rm > 0 ? ` ${rm}m` : ""}`;
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

export function termWidth(): number {
	return process.stdout.columns || 80;
}

export function wordWrap(text: string, width: number): string[] {
	const lines: string[] = [];
	const paragraphs = text.split("\n");

	for (const para of paragraphs) {
		const trimmed = para.trim();
		if (trimmed.length === 0) {
			lines.push("");
			continue;
		}
		const words = trimmed.split(/\s+/);
		let line = "";
		for (const word of words) {
			if (line.length > 0 && line.length + 1 + word.length > width) {
				lines.push(line);
				line = word;
			} else {
				line = line ? `${line} ${word}` : word;
			}
		}
		if (line) lines.push(line);
	}

	return lines;
}
