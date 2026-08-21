import type { EngineEvent, Task } from "./types.ts";
import { watchPaths } from "./watch.ts";

export interface SuperviseHooks {
	/** Run the task's own body once, ending when `signal` aborts. */
	runBody(signal: AbortSignal): Promise<number>;
	/** Re-run the task's dependencies. False means the rebuild failed. */
	rebuild(signal: AbortSignal): Promise<boolean>;
	emit(event: EngineEvent): void;
	rootDir: string;
}

type Wake =
	| { kind: "exit"; code: number }
	| { kind: "change" }
	| { kind: "abort" };

function aborted(signal: AbortSignal): Promise<Wake> {
	if (signal.aborted) return Promise.resolve({ kind: "abort" });
	return new Promise((resolve) => {
		signal.addEventListener("abort", () => resolve({ kind: "abort" }), {
			once: true,
		});
	});
}

/** Stop the current body and wait for it to actually finish. */
async function stop(
	controller: AbortController,
	body: Promise<number>,
): Promise<void> {
	controller.abort();
	await body.catch(() => 0);
}

type Cycle =
	| { kind: "exit"; code: number }
	| { kind: "restart"; rebuild: boolean }
	| { kind: "stopped" };

/** Block until the next change, or false if the run was torn down first. */
async function waitForChange(
	watcher: { next(): Promise<void> },
	signal: AbortSignal,
): Promise<boolean> {
	const wake = await Promise.race([
		watcher.next().then((): Wake => ({ kind: "change" })),
		aborted(signal),
	]);
	return wake.kind === "change";
}

/** Run the body once, returning why it ended. */
async function runCycle(
	signal: AbortSignal,
	hooks: SuperviseHooks,
	watcher: { next(): Promise<void> },
	opts: { interrupt: boolean; onRestart: () => void },
): Promise<Cycle> {
	const child = new AbortController();
	const relay = () => child.abort();
	signal.addEventListener("abort", relay, { once: true });
	const body = hooks.runBody(child.signal);

	try {
		for (;;) {
			const wake: Wake = await Promise.race([
				body.then((code): Wake => ({ kind: "exit", code })),
				watcher.next().then((): Wake => ({ kind: "change" })),
				aborted(signal),
			]);

			if (wake.kind === "abort") {
				await stop(child, body);
				return { kind: "stopped" };
			}
			if (wake.kind === "exit") return { kind: "exit", code: wake.code };

			opts.onRestart();
			if (opts.interrupt) {
				await stop(child, body);
				return { kind: "restart", rebuild: true };
			}
			if (await hooks.rebuild(signal)) {
				await stop(child, body);
				return { kind: "restart", rebuild: false };
			}
			// A failed rebuild keeps the current process serving.
		}
	} finally {
		signal.removeEventListener("abort", relay);
	}
}

/** Run a pending rebuild, waiting for a fix if it fails. */
async function settleRebuild(
	hooks: SuperviseHooks,
	watcher: { next(): Promise<void> },
	signal: AbortSignal,
): Promise<"ready" | "retry" | "stop"> {
	if (await hooks.rebuild(signal)) return "ready";
	// Wait for the next edit rather than spinning on a broken tree.
	return (await waitForChange(watcher, signal)) ? "retry" : "stop";
}

/** The restart loop, once a watcher exists. */
async function superviseLoop(
	signal: AbortSignal,
	hooks: SuperviseHooks,
	watcher: { next(): Promise<void> },
	opts: { interrupt: boolean; onRestart: () => void },
): Promise<number> {
	let pendingRebuild = false;

	while (!signal.aborted) {
		if (pendingRebuild) {
			const status = await settleRebuild(hooks, watcher, signal);
			if (status === "stop") return 0;
			if (status === "retry") continue;
			pendingRebuild = false;
		}

		const cycle = await runCycle(signal, hooks, watcher, opts);
		if (cycle.kind !== "restart") {
			return cycle.kind === "exit" ? cycle.code : 0;
		}
		pendingRebuild = cycle.rebuild;
	}
	return 0;
}

/**
 * Keep a persistent task running, restarting it when its watched files change.
 *
 * The rebuild ordering is what `interrupt` selects. Interrupting stops the
 * process first, which is mandatory when the rebuild rewrites the executable
 * that is currently running. Otherwise the rebuild happens while the old
 * process still serves, so a failed rebuild costs nothing.
 */
export async function supervise(
	task: Task,
	signal: AbortSignal,
	hooks: SuperviseHooks,
): Promise<number> {
	const spec = task.watch;
	if (!spec) return hooks.runBody(signal);

	// Awaited, not returned: `using` would dispose the watcher before the loop ran.
	using watcher = watchPaths(hooks.rootDir, spec);
	const code = await superviseLoop(signal, hooks, watcher, {
		interrupt: spec.interrupt ?? false,
		onRestart: () =>
			hooks.emit({
				type: "task-restart",
				ts: new Date().toISOString(),
				task: task.name,
				reason: "files changed",
			}),
	});
	return code;
}
