import { resolve } from "node:path";
import { resolveCmd } from "./proc.ts";
import type { CommandDef, CommandObject } from "./types.ts";

/** Resolve a CommandDef to a spawnable cmd array and its options */
export function resolveCommandDef(def: CommandDef): {
	cmd: string[];
	opts: Partial<CommandObject>;
} {
	if (typeof def === "string") return { cmd: resolveCmd(def), opts: {} };
	if (Array.isArray(def)) return { cmd: def, opts: {} };
	return { cmd: resolveCmd(def.cmd), opts: def };
}

/** Resolve cwd from command-level, subsystem-level, or root fallback */
export function resolveCwd(
	rootDir: string,
	cmdCwd?: string,
	subsystemCwd?: string,
): string {
	if (cmdCwd) return resolve(rootDir, cmdCwd);
	if (subsystemCwd) return resolve(rootDir, subsystemCwd);
	return rootDir;
}

/** Append passthrough args, handling sh -c commands correctly */
export function appendPassthrough(
	cmd: string[],
	passthrough: string[],
): string[] {
	if (passthrough.length === 0) return cmd;
	if (cmd[0] === "sh" && cmd[1] === "-c") {
		return ["sh", "-c", `${cmd[2]} ${passthrough.join(" ")}`];
	}
	return [...cmd, ...passthrough];
}
