import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { hasTool } from "./tools.ts";
import type { LockSpec } from "./types.ts";

// $0 is the lockfile, "$@" the real command, fd 3 the parent's ack pipe. The pid file names the
// holder for waiters, and is written by the shell that exec's the command, so it stays valid.
const ACK_SCRIPT = 'printf %s "$$" > "$0.holder"; printf . >&3; exec "$@"';
const PLAIN_SCRIPT = 'printf %s "$$" > "$0.holder"; exec "$@"';

let flockWarned = false;

/** Whether flock(1) is usable. Warns once when it is not, then everything runs unlocked. */
function flockAvailable(): boolean {
	if (hasTool("flock")) return true;
	if (!flockWarned) {
		flockWarned = true;
		process.stderr.write(
			"tempo: flock not found, running without a build lock\n",
		);
	}
	return false;
}

/** Absolute lockfile path for a spec. `true` derives one from the project root. */
export function resolveLockFile(
	spec: LockSpec | undefined,
	rootDir: string,
): string | undefined {
	if (!spec) return undefined;
	if (typeof spec === "string") return resolve(rootDir, spec);
	const key = createHash("sha256").update(rootDir).digest("hex").slice(0, 12);
	return join(tmpdir(), `tempo-${basename(rootDir)}-${key}.lock`);
}

/** Lockfile for one command, its own spec winning over the subsystem's. */
export function lockFileFor(
	rootDir: string,
	subsystemLock: LockSpec | undefined,
	commandLock: LockSpec | undefined,
): string | undefined {
	const spec = commandLock ?? subsystemLock;
	if (!spec) return undefined;
	if (!flockAvailable()) return undefined;
	return resolveLockFile(spec, rootDir);
}

/**
 * Wrap a command so it holds an exclusive lock for its lifetime.
 * The lock is a kernel-held fd inherited across exec, so it releases even on SIGKILL.
 * `-F` keeps the pid ours, so signals sent to the child still reach the real command.
 */
export function lockArgv(
	lockFile: string,
	cmd: string[],
	options?: { ack?: boolean },
): string[] {
	const script = options?.ack ? ACK_SCRIPT : PLAIN_SCRIPT;
	return ["flock", "-F", lockFile, "sh", "-c", script, lockFile, ...cmd];
}

/** Pid of the live process holding the lock, or null when unheld or unknown. */
export function lockHolderPid(lockFile: string): number | null {
	try {
		const raw = readFileSync(`${lockFile}.holder`, "utf8").trim();
		const pid = Number.parseInt(raw, 10);
		if (!Number.isInteger(pid) || pid <= 0) return null;
		process.kill(pid, 0);
		return pid;
	} catch {
		return null;
	}
}

/** Non-blocking probe. Only meaningful as a status hint: the answer can change immediately. */
export function isLockHeld(lockFile: string): boolean {
	if (!flockAvailable()) return false;
	const result = spawnSync("flock", ["-n", lockFile, "true"], {
		stdio: "ignore",
	});
	return result.status !== 0;
}

/** Describe the current holder for a status line. */
export function lockHolderLabel(lockFile: string): string {
	const pid = lockHolderPid(lockFile);
	return pid === null ? "waiting for lock" : `waiting for lock (pid ${pid})`;
}

/** Announce a held lock before a synchronous command blocks on it. */
export function noteLockWait(lockFile: string): void {
	if (!isLockHeld(lockFile)) return;
	process.stderr.write(`${lockHolderLabel(lockFile)}\n`);
}
