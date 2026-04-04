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

/** Print a warning for a missing tool to stderr */
export function warnMissingTool(cmd: string, consequence: string): void {
	process.stderr.write(
		`\x1b[33m\u26A0 ${cmd} not found\x1b[0m, ${consequence}\n`,
	);
}

/** Returns true if the Docker daemon is reachable */
export function hasDockerDaemon(): boolean {
	if (!hasTool("docker")) return false;
	try {
		const result = spawnSync("docker", ["info"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		return result.status === 0;
	} catch {
		return false;
	}
}

/** Throw if Docker is not installed or the daemon is not running */
export function requireDockerDaemon(): void {
	if (!hasTool("docker")) {
		throw new Error("docker not found -- install Docker first");
	}
	if (!hasDockerDaemon()) {
		throw new Error("Docker daemon is not running -- start Docker first");
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
