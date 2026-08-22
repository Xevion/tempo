import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeSync,
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

/** True when the recorded holder is gone, so its lock is ours to take. */
function abandoned(file: string): boolean {
	let holder: Holder;
	try {
		holder = JSON.parse(readFileSync(file, "utf8")) as Holder;
	} catch {
		// Either the holder vanished between the failed open and this read, in which
		// case the next attempt wins it, or the file is not ours to interpret.
		return false;
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

function claim(file: string, task: string): boolean {
	let fd: number;
	try {
		fd = openSync(file, "wx");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		return false;
	}
	const holder: Holder = {
		pid: process.pid,
		host: hostname(),
		task,
		since: new Date().toISOString(),
	};
	try {
		writeSync(fd, JSON.stringify(holder));
	} finally {
		closeSync(fd);
	}
	return true;
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
	let announced = false;
	let delay = POLL_MIN_MS;

	while (!claim(file, opts.task)) {
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
