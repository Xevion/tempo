import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The directory tempo writes into: caches, locks, and anything else it owns. */
export const TEMPO_DIR = ".tempo";

/**
 * Create a directory under `.tempo`, keeping the whole tree out of git.
 *
 * A consumer should not have to add an ignore rule for a directory they did not
 * ask for, so the first write drops one that ignores everything beneath it.
 */
export function ensureWorkDir(rootDir: string, ...segments: string[]): string {
	const base = join(rootDir, TEMPO_DIR);
	const marker = join(base, ".gitignore");
	const fresh = !existsSync(marker);
	const dir = join(base, ...segments);
	mkdirSync(dir, { recursive: true });
	if (fresh) writeFileSync(marker, "*\n");
	return dir;
}
