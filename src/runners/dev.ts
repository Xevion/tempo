import { resolve } from "node:path";
import { getLogger } from "@logtape/logtape";
import { ProcessGroup, TempoAbortError } from "../proc.ts";
import { isAll, resolveTargets, targetLabel } from "../targets.ts";
import type { HookContext, ResolvedConfig, TempoLogger } from "../types.ts";
import { BackendWatcher } from "../watch.ts";

const logger = getLogger(["tempo", "dev"]);

export async function runDev(
	config: ResolvedConfig,
	args: string[],
	flags: Record<string, unknown>,
	passthrough: string[],
): Promise<number> {
	const subsystemNames = Object.keys(config.subsystems) as string[];
	const targetResult = resolveTargets(args, config.subsystems);

	const allTargeted = isAll(targetResult, subsystemNames);
	if (!allTargeted) {
		logger.info("scope: {label}", { label: targetLabel(targetResult) });
	}

	const group = new ProcessGroup({ signal: "natural" });

	// Build hook context
	const cleanupFns: (() => void | Promise<void>)[] = [];
	const hookEnv: Record<string, string> = {};
	const hookLogTape = getLogger(["tempo", "hooks"]);
	const tempoLogger: TempoLogger = {
		info: (msg: string) => hookLogTape.info(msg),
		warn: (msg: string) => hookLogTape.warn(msg),
		error: (msg: string) => hookLogTape.error(msg),
	};
	const hookCtx: HookContext = {
		config,
		flags,
		targets: targetResult.subsystems as Set<string>,
		env: hookEnv,
		logger: tempoLogger,
		addCleanup: (fn) => cleanupFns.push(fn),
		fail: (msg: string): never => {
			hookLogTape.error(msg);
			throw new TempoAbortError(msg);
		},
	};

	// Run before:dev hook
	if (config.hooks?.["before:dev"]) {
		try {
			await config.hooks["before:dev"](hookCtx);
		} catch (e) {
			if (e instanceof TempoAbortError) return 1;
			throw e;
		}
	}

	const envOverrides: Record<string, string> = { ...hookEnv };

	// Spawn processes
	const processes = config.dev?.processes ?? {};
	for (const subsystem of targetResult.subsystems) {
		const procDef = processes[subsystem as keyof typeof processes];
		if (!procDef) continue;

		const sub = config.subsystems[subsystem];
		const baseCwd = sub.cwd ? resolve(config.rootDir, sub.cwd) : config.rootDir;

		if (procDef.type === "unmanaged") {
			const cwd = procDef.cwd ? resolve(config.rootDir, procDef.cwd) : baseCwd;
			const env = { ...envOverrides, ...procDef.env };
			logger.info("start {subsystem} (unmanaged)", { subsystem });
			group.spawn(procDef.cmd, { cwd, env, inheritStdin: true });
		} else if (procDef.type === "managed") {
			const cwd = procDef.cwd ? resolve(config.rootDir, procDef.cwd) : baseCwd;
			const env = { ...envOverrides, ...procDef.env };
			const passthroughArgs = procDef.run.passthrough ? passthrough : [];

			logger.info("start {subsystem} (managed)", { subsystem });

			const watcher = new BackendWatcher(group, {
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
			});

			group.onCleanup(() => watcher.killSync());
			group.onAsyncCleanup(() => watcher.shutdown());
			watcher.start();
		}
	}

	// Wait based on exit behavior
	const exitBehavior = config.dev?.exitBehavior ?? "first-exits";
	let exitCode: number;

	if (exitBehavior === "first-exits") {
		exitCode = await group.waitForFirst();
	} else {
		exitCode = await group.waitForAll();
	}

	// Run after:dev hook
	if (config.hooks?.["after:dev"]) {
		await config.hooks["after:dev"](hookCtx);
	}

	// Cleanup
	for (const fn of cleanupFns) {
		try {
			await fn();
		} catch {
			// best-effort
		}
	}

	return exitCode;
}
