import { resolve } from "node:path";
import { getLogger } from "@logtape/logtape";
import { TempoConfigError } from "../errors.ts";
import { buildHookContext, runCleanups, tryHook } from "../hooks.ts";
import { ProcessGroup } from "../proc.ts";
import { resolveAndLogTargets } from "../targets.ts";
import type { DevProcess, ResolvedConfig } from "../types.ts";
import { BackendWatcher } from "../watch.ts";

const logger = getLogger(["tempo", "dev"]);

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_READY_POLL_MS = 250;

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function createDeferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Polls `readyCheck` until it passes or `timeoutMs` elapses (logging a warning and giving up either way). */
async function waitUntilReady(
	subsystem: string,
	readyCheck: () => Promise<boolean>,
	timeoutMs: number,
	pollMs: number,
	isCancelled: () => boolean,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		// Teardown must not wait out the deadline, or Ctrl-C stalls for readyTimeoutMs.
		if (isCancelled()) return;
		const ok = await readyCheck().catch(() => false);
		if (ok) return;
		await new Promise((r) => setTimeout(r, pollMs));
	}
	logger.warn(
		"{subsystem} readyCheck did not pass within {timeoutMs}ms, continuing anyway",
		{
			subsystem,
			timeoutMs,
		},
	);
}

/** Returns the first `dependsOn` cycle as the path that closes it, or null when the graph is acyclic. */
function findDependencyCycle(
	processes: Partial<Record<string, DevProcess>>,
): string[] | null {
	const state = new Map<string, "visiting" | "done">();
	const path: string[] = [];

	const visit = (name: string): string[] | null => {
		const seen = state.get(name);
		if (seen === "done") return null;
		if (seen === "visiting") return [...path.slice(path.indexOf(name)), name];
		state.set(name, "visiting");
		path.push(name);
		for (const dep of processes[name]?.dependsOn ?? []) {
			const cycle = visit(dep);
			if (cycle) return cycle;
		}
		path.pop();
		state.set(name, "done");
		return null;
	};

	for (const name of Object.keys(processes)) {
		const cycle = visit(name);
		if (cycle) return cycle;
	}
	return null;
}

/** Rejects unsatisfiable `dependsOn` graphs: unknown names and cycles. */
function validateDependencies(
	processes: Partial<Record<string, DevProcess>>,
): void {
	const names = Object.keys(processes);
	for (const name of names) {
		for (const dep of processes[name]?.dependsOn ?? []) {
			if (processes[dep]) continue;
			const valid = names.map((n) => `  ${n}`).join("\n");
			throw new TempoConfigError(
				`dev process "${name}" dependsOn "${dep}", which is not a configured dev process.\n\nConfigured dev processes:\n${valid}`,
			);
		}
	}

	const cycle = findDependencyCycle(processes);
	if (cycle) {
		throw new TempoConfigError(
			`dev process dependency cycle: ${cycle.join(" -> ")}`,
		);
	}
}

/** Awaits the ready deferreds of `procDef.dependsOn`. Names outside the current targets are not waited on. */
async function awaitDependencies(
	subsystem: string,
	procDef: DevProcess,
	readyDeferreds: Map<string, Deferred>,
): Promise<void> {
	const waited: Promise<void>[] = [];
	const names: string[] = [];
	for (const dep of procDef.dependsOn ?? []) {
		const deferred = readyDeferreds.get(dep);
		if (!deferred) {
			logger.warn(
				"{subsystem} dependsOn {dep}, which is not in the current targets; not waiting for it",
				{ subsystem, dep },
			);
			continue;
		}
		waited.push(deferred.promise);
		names.push(dep);
	}
	if (waited.length === 0) return;
	logger.info("{subsystem} waiting on {dependsOn}", {
		subsystem,
		dependsOn: names.join(", "),
	});
	await Promise.all(waited);
}

/** Starts polling `procDef.readyCheck` (if declared) and resolves `deferred` once ready or timed out. */
function registerReadiness(
	subsystem: string,
	procDef: DevProcess,
	deferred: Deferred,
	isCancelled: () => boolean,
): void {
	if (!procDef.readyCheck) {
		deferred.resolve();
		return;
	}
	waitUntilReady(
		subsystem,
		procDef.readyCheck,
		procDef.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
		procDef.readyPollMs ?? DEFAULT_READY_POLL_MS,
		isCancelled,
	).then(() => deferred.resolve());
}

function resolveProcessCwd(
	rootDir: string,
	procDef: DevProcess,
	baseCwd: string,
): string {
	return procDef.cwd ? resolve(rootDir, procDef.cwd) : baseCwd;
}

function spawnUnmanaged(
	group: ProcessGroup,
	subsystem: string,
	procDef: Extract<DevProcess, { type: "unmanaged" }>,
	cwd: string,
	env: Record<string, string>,
	json: boolean | undefined,
): void {
	logger.info("start {subsystem} (unmanaged)", { subsystem });
	group.spawn(procDef.cmd, {
		cwd,
		env,
		inheritStdin: true,
		name: subsystem,
		json,
	});
}

function spawnManaged(
	group: ProcessGroup,
	subsystem: string,
	procDef: Extract<DevProcess, { type: "managed" }>,
	cwd: string,
	env: Record<string, string>,
	json: boolean | undefined,
	passthrough: string[],
): void {
	logger.info("start {subsystem} (managed)", { subsystem });
	const passthroughArgs = procDef.run.passthrough ? passthrough : [];

	const watcher = new BackendWatcher({
		watchDirs: procDef.watch.dirs,
		watchExts: procDef.watch.exts,
		extraPaths: procDef.watch.extraPaths,
		buildCmd: procDef.build.cmd,
		runCmd: procDef.run.cmd,
		debounce: procDef.watch.debounce,
		interrupt: procDef.interrupt,
		verboseBuild: procDef.build.verbose,
		cwd,
		env,
		passthrough: passthroughArgs,
		json,
		name: subsystem,
	});

	group.onCleanup(() => watcher.killSync());
	group.onAsyncCleanup(() => watcher.shutdown());
	group.waitOn(watcher.done);
	watcher.start();
}

export async function runDev(
	config: ResolvedConfig,
	args: string[],
	flags: Record<string, unknown>,
	passthrough: string[],
): Promise<number> {
	const targetResult = resolveAndLogTargets(args, config.subsystems, logger);

	const group = new ProcessGroup({ signal: "natural" });
	let tearingDown = false;

	try {
		const { hookCtx, cleanupFns, hookEnv } = buildHookContext(
			config,
			flags,
			targetResult.subsystems,
		);

		const hookAbort = await tryHook(config.hooks?.["before:dev"], hookCtx);
		if (hookAbort !== null) return hookAbort;

		const envOverrides: Record<string, string> = { ...hookEnv };

		// Deferreds are created up front so dependsOn resolves regardless of spawn order.
		const processes = config.dev?.processes ?? {};
		validateDependencies(processes);

		const targeted = [...targetResult.subsystems].filter((s) => processes[s]);
		if (targeted.length === 0) {
			logger.warn("no dev processes configured for the current targets");
		}
		const readyDeferreds = new Map<string, Deferred>(
			targeted.map((s) => [s, createDeferred()]),
		);
		const isTearingDown = () => tearingDown || group.shuttingDown;

		const spawnTasks = targeted.map(async (subsystem) => {
			const procDef = processes[subsystem];
			if (!procDef) return;

			await awaitDependencies(subsystem, procDef, readyDeferreds);

			const deferred = readyDeferreds.get(subsystem);
			// Teardown may have started while waiting; release dependents before bailing.
			if (isTearingDown()) {
				deferred?.resolve();
				return;
			}

			const sub = config.subsystems[subsystem];
			const baseCwd = sub?.cwd
				? resolve(config.rootDir, sub.cwd)
				: config.rootDir;
			const cwd = resolveProcessCwd(config.rootDir, procDef, baseCwd);
			const env = { ...envOverrides, ...procDef.env };

			if (procDef.type === "unmanaged") {
				spawnUnmanaged(group, subsystem, procDef, cwd, env, config.json);
			} else {
				spawnManaged(
					group,
					subsystem,
					procDef,
					cwd,
					env,
					config.json,
					passthrough,
				);
			}

			if (deferred) {
				registerReadiness(subsystem, procDef, deferred, isTearingDown);
			}
		});

		await Promise.all(spawnTasks);

		// Wait based on exit behavior
		const exitBehavior = config.dev?.exitBehavior ?? "first-exits";
		let exitCode: number;

		if (exitBehavior === "first-exits") {
			exitCode = await group.waitForFirst();
		} else {
			exitCode = await group.waitForAll();
		}

		// Ctrl-C ends a dev session; it is not a failure.
		if (group.signalReceived !== null) {
			exitCode = 0;
		}

		// Run after:dev hook
		if (config.hooks?.["after:dev"]) {
			await config.hooks["after:dev"](hookCtx);
		}

		await runCleanups(cleanupFns);

		return exitCode;
	} finally {
		// Kill before disposing, or a spawn error leaves started processes orphaned.
		tearingDown = true;
		await group.killAll();
		group.dispose();
	}
}
