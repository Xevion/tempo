import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUN_LOCKFILES = ["bun.lockb", "bun.lock"];
const REEXEC_ENV = "TEMPO_REEXEC";

/** Walk up from startDir looking for bun.lockb or bun.lock */
export function detectBunProject(startDir?: string): boolean {
	let dir = resolve(startDir ?? process.cwd());
	const root = resolve("/");

	while (true) {
		for (const lockfile of BUN_LOCKFILES) {
			if (existsSync(resolve(dir, lockfile))) return true;
		}
		if (dir === root) return false;
		dir = dirname(dir);
	}
}

/**
 * Returns true when all of these hold:
 * - Not already running under Bun
 * - Not in a re-exec loop (TEMPO_REEXEC not set)
 * - Project has a bun lockfile (walk-up search from cwd)
 * - `bun` is available on PATH
 */
export function shouldReexec(): boolean {
	if (process.env[REEXEC_ENV]) return false;
	if ("Bun" in globalThis) return false;
	if (!detectBunProject()) return false;
	return isBunAvailable();
}

/** Check if `bun` is on PATH */
export function isBunAvailable(): boolean {
	try {
		return spawnSync("which", ["bun"], { stdio: "ignore" }).status === 0;
	} catch {
		return false;
	}
}

/**
 * Re-exec under bun, forwarding all args and stdio.
 * Targets src/cli.ts (raw TS) rather than dist/cli.mjs to avoid
 * potential dead-code elimination of Bun branches in the built output.
 */
export function reexecUnderBun(): never {
	const selfDir = dirname(fileURLToPath(import.meta.url));
	// When running from dist/cli.mjs, resolve to ../src/cli.ts
	// When running from src/ directly, fall back to self
	const srcCli = resolve(selfDir, "..", "src", "cli.ts");
	const target = existsSync(srcCli) ? srcCli : fileURLToPath(import.meta.url);

	const result = spawnSync("bun", ["run", target, ...process.argv.slice(2)], {
		stdio: "inherit",
		env: { ...process.env, [REEXEC_ENV]: "1" },
	});
	process.exit(result.status ?? 1);
}
