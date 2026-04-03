import { spawnSync } from "node:child_process";
import type { CommandDef } from "./types.ts";

const toolCache = new Map<string, boolean>();

export function hasTool(cmd: string): boolean {
	const cached = toolCache.get(cmd);
	if (cached !== undefined) return cached;
	try {
		const result = spawnSync("which", [cmd], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const found = result.status === 0;
		toolCache.set(cmd, found);
		return found;
	} catch {
		toolCache.set(cmd, false);
		return false;
	}
}

/** Collect requires from subsystem + command definition, deduped */
export function collectRequires(
	subsystemRequires: string[] | undefined,
	def: CommandDef,
): string[] {
	const cmdRequires =
		typeof def === "object" && !Array.isArray(def) ? def.requires : undefined;
	if (
		(subsystemRequires?.length ?? 0) === 0 &&
		(cmdRequires?.length ?? 0) === 0
	)
		return [];
	return [...new Set([...(subsystemRequires ?? []), ...(cmdRequires ?? [])])];
}

/** Return tool names from a requires list that are not on PATH */
export function getMissingTools(requires: string[]): string[] {
	return requires.filter((tool) => !hasTool(tool));
}

/** Returns missing tool names if any required tools are absent, null if all present */
export function checkMissingTools(
	subsystemRequires: string[] | undefined,
	def: CommandDef,
): string[] | null {
	const requires = collectRequires(subsystemRequires, def);
	if (requires.length === 0) return null;
	const missing = getMissingTools(requires);
	return missing.length > 0 ? missing : null;
}
