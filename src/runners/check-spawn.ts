import { resolveCommandDef, resolveCwd, spawnCollect } from "../proc.ts";
import type { CollectResult, CommandDef, ResolvedConfig } from "../types.ts";

export interface CheckEntry {
	name: string;
	subsystem: string;
	action: string;
	def: CommandDef;
}

/** Spawn all checks in parallel, returning promises and fallbacks for raceInOrder */
export function spawnChecks(
	checks: CheckEntry[],
	config: ResolvedConfig,
	envOverrides: Record<string, string>,
	startTime: number,
): { promises: Promise<CollectResult>[]; fallbacks: CollectResult[] } {
	const promises: Promise<CollectResult>[] = [];
	const fallbacks: CollectResult[] = [];

	for (const check of checks) {
		const { cmd, opts } = resolveCommandDef(check.def);
		const sub = config.subsystems[check.subsystem]!;
		const checkOpts =
			config.check?.options?.[check.name as `${string}:${string}`];

		const env = { ...envOverrides, ...opts.env, ...checkOpts?.env };
		const cwd = resolveCwd(config.rootDir, opts.cwd, sub.cwd);
		const timeout = opts.timeout ?? checkOpts?.timeout;

		promises.push(
			spawnCollect(cmd, startTime, { cwd, env, name: check.name, timeout }),
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
