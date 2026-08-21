import type { FSWatcher } from "node:fs";
import { existsSync, watch } from "node:fs";
import { extname, resolve } from "node:path";

const DEFAULT_DEBOUNCE_MS = 300;

export interface WatchSpec {
	/** Files and directories to watch. Directories are watched recursively. */
	paths: string[];
	/** Extensions worth reacting to, e.g. `[".rs", ".sql"]`. Empty means all. */
	exts?: string[];
	debounce?: number;
	/**
	 * Stop the process before rebuilding rather than after.
	 *
	 * Required whenever the rebuild rewrites the running executable: a live
	 * binary cannot be replaced in place.
	 */
	interrupt?: boolean;
}

export interface Watcher extends Disposable {
	/** Resolves on the next debounced change, or never if closed first. */
	next(): Promise<void>;
	close(): void;
}

function matchesExt(file: string, exts: string[] | undefined): boolean {
	if (!exts || exts.length === 0) return true;
	const ext = extname(file);
	return exts.some((e) => (e.startsWith(".") ? e : `.${e}`) === ext);
}

/**
 * Watch a set of paths, coalescing bursts into a single debounced signal.
 *
 * Editors write a file several times in quick succession, and a rebuild per
 * write is both wasteful and racy, so changes are collapsed into one wake-up.
 */
export function watchPaths(root: string, spec: WatchSpec): Watcher {
	const debounce = spec.debounce ?? DEFAULT_DEBOUNCE_MS;
	const watchers: FSWatcher[] = [];
	let timer: ReturnType<typeof setTimeout> | null = null;
	let waiting: (() => void) | null = null;
	let closed = false;

	const fire = () => {
		timer = null;
		const resume = waiting;
		waiting = null;
		resume?.();
	};

	const onEvent = (filename: string | null) => {
		if (closed) return;
		if (filename && !matchesExt(filename, spec.exts)) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(fire, debounce);
	};

	for (const p of spec.paths) {
		const full = resolve(root, p);
		if (!existsSync(full)) continue;
		try {
			const w = watch(full, { recursive: true }, (_event, filename) =>
				onEvent(typeof filename === "string" ? filename : null),
			);
			w.on("error", () => {
				// A watch that dies must not take the dev session with it.
			});
			watchers.push(w);
		} catch {
			// An unwatchable path is skipped rather than fatal.
		}
	}

	return {
		next(): Promise<void> {
			if (closed) return new Promise<void>(() => {});
			return new Promise<void>((resolve) => {
				waiting = resolve;
			});
		},
		close(): void {
			closed = true;
			if (timer) clearTimeout(timer);
			timer = null;
			waiting = null;
			for (const w of watchers) w.close();
			watchers.length = 0;
		},
		[Symbol.dispose](): void {
			this.close();
		},
	};
}
