import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasTool } from "./tools.ts";

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

/** True when this Node process should re-exec under bun. */
export function shouldReexec(): boolean {
	if (process.env[REEXEC_ENV]) return false;
	if ("Bun" in globalThis) return false;
	if (!detectBunProject()) return false;
	return isBunAvailable();
}

/** Check if `bun` is on PATH */
export function isBunAvailable(): boolean {
	return hasTool("bun");
}

/** Re-exec under bun. Targets raw src/cli.ts so Bun branches survive dead-code elimination. */
export function reexecUnderBun(): never {
	const selfDir = dirname(fileURLToPath(import.meta.url));
	// From dist/cli.mjs resolve to ../src/cli.ts; from src/ fall back to self.
	const srcCli = resolve(selfDir, "..", "src", "cli.ts");
	const target = existsSync(srcCli) ? srcCli : fileURLToPath(import.meta.url);

	const result = spawnSync("bun", ["run", target, ...process.argv.slice(2)], {
		stdio: "inherit",
		env: { ...process.env, [REEXEC_ENV]: "1" },
	});
	process.exit(result.status ?? 1);
}
