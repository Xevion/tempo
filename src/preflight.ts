import { existsSync, globSync, statSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import { elapsed } from "./fmt.ts";

const logger = getLogger(["tempo", "preflight"]);

/** Scan a directory recursively and return the highest mtimeMs among matching files */
export function newestMtime(dir: string, pattern: string): number {
	if (!existsSync(dir)) return 0;

	const matches = globSync(pattern, { cwd: dir });
	let newest = 0;

	for (const match of matches) {
		try {
			const stat = statSync(join(dir, match));
			if (stat.mtimeMs > newest) {
				newest = stat.mtimeMs;
			}
		} catch {
			// file may have been deleted between scan and stat
		}
	}

	return newest;
}

/** Check staleness and optionally regenerate. Returns true if regeneration ran. */
export function ensureFresh(opts: {
	label: string;
	sourceMtime: number;
	artifactDir: string;
	artifactGlob: string;
	reason?: string;
	regenerate: () => void;
}): boolean {
	const artifactMtime = newestMtime(opts.artifactDir, opts.artifactGlob);

	if (artifactMtime >= opts.sourceMtime) {
		logger.debug("{label} up-to-date, skipped", { label: opts.label });
		return false;
	}

	logger.info("regenerating {label}...{reason}", {
		label: opts.label,
		reason: opts.reason ? ` (${opts.reason})` : "",
	});

	const start = Date.now();
	const result: unknown = opts.regenerate();

	if (result && typeof result === "object" && "then" in result) {
		throw new Error(
			`ensureFresh called with async regenerate for "${opts.label}" — use ensureFreshAsync instead`,
		);
	}

	logger.info("{label} regenerated ({elapsed}s)", {
		label: opts.label,
		elapsed: elapsed(start),
	});
	return true;
}

/** Async variant of ensureFresh for async regenerate functions */
export async function ensureFreshAsync(opts: {
	label: string;
	sourceMtime: number;
	artifactDir: string;
	artifactGlob: string;
	reason?: string;
	regenerate: (() => void) | (() => Promise<void>);
}): Promise<boolean> {
	const artifactMtime = newestMtime(opts.artifactDir, opts.artifactGlob);

	if (artifactMtime >= opts.sourceMtime) {
		logger.debug("{label} up-to-date, skipped", { label: opts.label });
		return false;
	}

	logger.info("regenerating {label}...{reason}", {
		label: opts.label,
		reason: opts.reason ? ` (${opts.reason})` : "",
	});

	const start = Date.now();
	await opts.regenerate();

	logger.info("{label} regenerated ({elapsed}s)", {
		label: opts.label,
		elapsed: elapsed(start),
	});
	return true;
}
