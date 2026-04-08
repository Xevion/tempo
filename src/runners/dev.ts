import { resolve } from "node:path";
import { getLogger } from "@logtape/logtape";
import { buildHookContext, runCleanups, tryHook } from "../hooks.ts";
import { ProcessGroup } from "../proc.ts";
import { resolveAndLogTargets } from "../targets.ts";
import type { ResolvedConfig } from "../types.ts";
import { BackendWatcher } from "../watch.ts";

const logger = getLogger(["tempo", "dev"]);

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: dev runner with hooks, process spawning, and exit handling
export async function runDev(
	config: ResolvedConfig,
	args: string[],
	flags: Record<string, unknown>,
	passthrough: string[],
): Promise<number> {
	const targetResult = resolveAndLogTargets(args, config.subsystems, logger);

	const group = new ProcessGroup({ signal: "natural" });

	try {
		const { hookCtx, cleanupFns, hookEnv } = buildHookContext(
			config,
			flags,
			targetResult.subsystems,
		);

		const hookAbort = await tryHook(config.hooks?.["before:dev"], hookCtx);
		if (hookAbort !== null) return hookAbort;

		const envOverrides: Record<string, string> = { ...hookEnv };

		// Spawn processes
		const processes = config.dev?.processes ?? {};
		for (const subsystem of targetResult.subsystems) {
			const procDef = processes[subsystem];
			if (!procDef) continue;

			const sub = config.subsystems[subsystem];
			const baseCwd = sub?.cwd
				? resolve(config.rootDir, sub.cwd)
				: config.rootDir;

			if (procDef.type === "unmanaged") {
				const cwd = procDef.cwd
					? resolve(config.rootDir, procDef.cwd)
					: baseCwd;
				const env = { ...envOverrides, ...procDef.env };
				logger.info("start {subsystem} (unmanaged)", { subsystem });
				group.spawn(procDef.cmd, {
					cwd,
					env,
					inheritStdin: true,
					name: subsystem,
					json: config.json,
				});
			} else if (procDef.type === "managed") {
				const cwd = procDef.cwd
					? resolve(config.rootDir, procDef.cwd)
					: baseCwd;
				const env = { ...envOverrides, ...procDef.env };
				const passthroughArgs = procDef.run.passthrough ? passthrough : [];

				logger.info("start {subsystem} (managed)", { subsystem });

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
					json: config.json,
					name: subsystem,
				});

				group.onCleanup(() => watcher.killSync());
				group.onAsyncCleanup(() => watcher.shutdown());
				group.waitOn(watcher.done);
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

		await runCleanups(cleanupFns);

		return exitCode;
	} finally {
		group.dispose();
	}
}
