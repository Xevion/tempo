import { getLogger } from "@logtape/logtape";
import { TempoAbortError } from "./errors.ts";
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

/** Try to run a hook, returning 1 on TempoAbortError, null on success or if no hook */
export async function tryHook(
	hook:
		| ((ctx: HookContext, ...args: unknown[]) => void | Promise<void>)
		| undefined,
	hookCtx: HookContext,
	...args: unknown[]
): Promise<number | null> {
	if (!hook) return null;
	try {
		await hook(hookCtx, ...args);
	} catch (e) {
		if (e instanceof TempoAbortError) return 1;
		throw e;
	}
	return null;
}

/** Run cleanup functions best-effort */
export async function runCleanups(
	fns: (() => void | Promise<void>)[],
): Promise<void> {
	for (const fn of fns) {
		try {
			await fn();
		} catch {
			// best-effort
		}
	}
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
): Promise<{
	cleanupFns: (() => void | Promise<void>)[];
	hookEnv: Record<string, string>;
}> {
	const hookFn = config.hooks?.[hookName];
	if (!hookFn) return { cleanupFns: [], hookEnv: {} };

	const { hookCtx, cleanupFns, hookEnv } = buildHookContext(
		config,
		flags,
		targets,
	);
	const abort = await tryHook(hookFn, hookCtx);
	if (abort !== null) {
		await runCleanups(cleanupFns);
		throw new TempoAbortError("Hook aborted");
	}
	return { cleanupFns, hookEnv };
}
