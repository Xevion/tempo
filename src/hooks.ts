import { getLogger } from "@logtape/logtape";
import { TempoAbortError } from "./proc.ts";
import type { HookContext, ResolvedConfig, TempoLogger } from "./types.ts";

/** Build a HookContext with associated cleanup list and env overrides */
export function buildHookContext(
	config: ResolvedConfig,
	flags: Record<string, unknown>,
	targets: Set<string>,
): {
	hookCtx: HookContext;
	cleanupFns: (() => void | Promise<void>)[];
	hookEnv: Record<string, string>;
} {
	const cleanupFns: (() => void | Promise<void>)[] = [];
	const hookEnv: Record<string, string> = {};
	const hookLogTape = getLogger(["tempo", "hooks"]);
	const tempoLogger: TempoLogger = {
		info: (msg: string) => hookLogTape.info(msg),
		warn: (msg: string) => hookLogTape.warn(msg),
		error: (msg: string) => hookLogTape.error(msg),
	};
	const fail = (msg: string): never => {
		hookLogTape.error(msg);
		throw new TempoAbortError(msg);
	};

	const hookCtx: HookContext = {
		config,
		flags,
		targets,
		env: hookEnv,
		logger: tempoLogger,
		addCleanup: (fn) => cleanupFns.push(fn),
		fail,
	};

	return { hookCtx, cleanupFns, hookEnv };
}

/**
 * Fire a generic before:/after: hook for any command name.
 * Returns the cleanup functions registered during the hook (caller must drain them).
 */
export async function runCommandHook(
	config: ResolvedConfig,
	hookName: `before:${string}` | `after:${string}`,
	flags: Record<string, unknown>,
	targets: Set<string> = new Set(),
): Promise<(() => void | Promise<void>)[]> {
	const hookFn = config.hooks?.[hookName];
	if (!hookFn) return [];

	const { hookCtx, cleanupFns } = buildHookContext(config, flags, targets);
	await hookFn(hookCtx);
	return cleanupFns;
}
