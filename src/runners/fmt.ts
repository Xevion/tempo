import type { ResolvedConfig } from "../types.ts";
import { runSequential } from "./sequential.ts";

export async function runFmt(
	config: ResolvedConfig,
	args: string[],
	_flags: Record<string, unknown>,
	passthrough: string[],
): Promise<number> {
	return runSequential(config, args, passthrough, {
		commandKey: "format-apply",
		loggerName: "fmt",
		autoFixFallback: true,
	});
}
