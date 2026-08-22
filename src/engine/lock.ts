import {
	linkSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ensureWorkDir } from "./workdir.ts";

/**
 * Where a lock lives: `true` is the project-wide one, a string is a path.
 *
 * A relative path is taken from the project root; an absolute one reaches outside
 * it, for a tool whose cache is shared between repositories.
 */
export function lockPath(rootDir: string, lock: true | string): string {
	if (lock === true)
		return join(ensureWorkDir(rootDir, "locks"), "project.lock");
	return isAbsolute(lock) ? lock : resolve(rootDir, lock);
}

interface Holder {
	pid: number;
	host: string;
	task: string;
	since: string;
}

const POLL_MIN_MS = 20;
const POLL_MAX_MS = 250;

/**
 * True when the recorded holder is gone, so its lock is ours to take.
 *
 * A file that will not parse counts as abandoned. A claim links a complete
 * holder into place, so tempo never leaves a half-written one, and treating an
 * unreadable file as held would hang every later run forever.
 */
function abandoned(file: string): boolean {
	let holder: Holder;
	try {
		holder = JSON.parse(readFileSync(file, "utf8")) as Holder;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== "ENOENT";
	}
	// A pid from another machine says nothing about a process on this one.
	if (holder.host !== hostname() || typeof holder.pid !== "number")
		return false;
	try {
		process.kill(holder.pid, 0);
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/** Drop the lock, unless a stale takeover already handed it to someone else. */
function release(file: string): void {
	try {
		const holder = JSON.parse(readFileSync(file, "utf8")) as Holder;
		if (holder.pid !== process.pid || holder.host !== hostname()) return;
		unlinkSync(file);
	} catch {
		// Already gone, which is the state release wants.
	}
}

/**
 * Claim the lock by linking a fully written file into place.
 *
 * `link` fails when the name exists, so it is as exclusive as an O_EXCL create
 * while the content is already complete: a waiter can never read a half-written
 * holder and mistake it for an unreadable one.
 */
function claim(staged: string, file: string): boolean {
	try {
		linkSync(staged, file);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		return false;
	}
}

let staging = 0;

/** Write the holder beside the lock, on the same filesystem so it can be linked. */
function stageHolder(file: string, task: string): string {
	const path = `${file}.${process.pid}.${staging++}.staged`;
	const holder: Holder = {
		pid: process.pid,
		host: hostname(),
		task,
		since: new Date().toISOString(),
	};
	writeFileSync(path, JSON.stringify(holder));
	return path;
}

export interface AcquireOptions {
	signal?: AbortSignal;
	/** Recorded in the lock file, so a waiter can say who it is waiting on. */
	task: string;
	/** Called once, the first time the lock is found held. */
	onWait?: (holder: string) => void;
}

/**
 * Take an exclusive lock on a path, waiting for whoever holds it.
 *
 * Exclusivity rests on an atomic create rather than on `flock`, which is not a
 * command every platform ships. A holder killed outright leaves its file behind,
 * so a waiter that finds no such process takes the lock instead of hanging.
 */
export async function acquireLock(
	file: string,
	opts: AcquireOptions,
): Promise<Disposable & { waitedMs: number }> {
	mkdirSync(dirname(file), { recursive: true });
	const began = performance.now();
	const staged = stageHolder(file, opts.task);
	let announced = false;
	let delay = POLL_MIN_MS;

	try {
		while (!claim(staged, file)) {
			opts.signal?.throwIfAborted();
			if (abandoned(file)) {
				try {
					unlinkSync(file);
				} catch {
					// Someone else cleaned up first, which is equally good.
				}
				continue;
			}
			if (!announced) {
				announced = true;
				opts.onWait?.(holderName(file));
			}
			await sleep(delay, opts.signal);
			delay = Math.min(delay * 2, POLL_MAX_MS);
		}
	} finally {
		// The lock holds the content under its own name now, linked or not.
		unlinkSync(staged);
	}

	const cleanup = () => release(file);
	process.once("exit", cleanup);
	return {
		waitedMs: performance.now() - began,
		[Symbol.dispose]() {
			process.removeListener("exit", cleanup);
			cleanup();
		},
	};
}

/** Who to name in a wait message, falling back to the path when unreadable. */
function holderName(file: string): string {
	try {
		const holder = JSON.parse(readFileSync(file, "utf8")) as Holder;
		return holder.task || file;
	} catch {
		return file;
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolvePromise();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
