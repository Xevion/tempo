import { CLEAR_LINE, c, isStderrTTY } from "../fmt.ts";
import { lockFileFor, lockHolderLabel } from "../lock.ts";
import { spawnCollect } from "../proc.ts";
import { resolveCommandDef, resolveCwd } from "../resolve.ts";
import type { CollectResult, CommandDef, ResolvedConfig } from "../types.ts";

export interface CheckEntry {
	name: string;
	subsystem: string;
	action: string;
	def: CommandDef;
}

/** Reports a check's progress while it waits on a lock */
export interface LockWaitReporter {
	waiting(name: string, note: string): void;
	acquired(name: string): void;
}

/** Fall back to a single stderr line when there is no spinner to hang the status on */
function plainReporter(config: ResolvedConfig): LockWaitReporter {
	const announced = new Set<string>();
	return {
		waiting(name, note) {
			if (config.json || announced.has(name)) return;
			announced.add(name);
			const clear = isStderrTTY ? CLEAR_LINE : "";
			process.stderr.write(`${clear}${c.overlay0(`${name} ${note}`)}\n`);
		},
		acquired() {},
	};
}

/** Spawn all checks in parallel, returning promises and fallbacks for drainAsCompleted */
export function spawnChecks(
	checks: CheckEntry[],
	config: ResolvedConfig,
	envOverrides: Record<string, string>,
	reporter?: LockWaitReporter,
): { promises: Promise<CollectResult>[]; fallbacks: CollectResult[] } {
	const promises: Promise<CollectResult>[] = [];
	const fallbacks: CollectResult[] = [];
	const report = reporter ?? plainReporter(config);

	for (const check of checks) {
		const { cmd, opts } = resolveCommandDef(check.def);
		const sub = config.subsystems[check.subsystem];
		if (!sub) continue;
		const checkOpts =
			config.check?.options?.[check.name as `${string}:${string}`];

		const env = { ...envOverrides, ...opts.env, ...checkOpts?.env };
		const cwd = resolveCwd(config.rootDir, opts.cwd, sub.cwd);
		const timeout = opts.timeout ?? checkOpts?.timeout;
		const lockFile = lockFileFor(config.rootDir, sub.lock, opts.lock);
		const lock = lockFile
			? {
					file: lockFile,
					onWait: (waitedMs: number) =>
						report.waiting(
							check.name,
							`${lockHolderLabel(lockFile)} ${(waitedMs / 1000).toFixed(0)}s`,
						),
					onAcquire: () => report.acquired(check.name),
				}
			: undefined;

		promises.push(
			spawnCollect(cmd, { cwd, env, name: check.name, timeout, lock }),
		);
		fallbacks.push({
			name: check.name,
			stdout: "",
			stderr: "check timed out or was interrupted",
			exitCode: 1,
			elapsed: "0.0",
		});
	}

	return { promises, fallbacks };
}
