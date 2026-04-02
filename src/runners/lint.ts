import type { ResolvedConfig } from "../types.ts";
import { runSequential } from "./sequential.ts";

export async function runLint(
	config: ResolvedConfig,
	args: string[],
	_flags: Record<string, unknown>,
	passthrough: string[],
): Promise<number> {
	return runSequential(config, args, passthrough, {
		commandKey: "lint",
		loggerName: "lint",
	});
}
