import { spawnSync } from "node:child_process";
import { TempoAbortError } from "./errors.ts";
import type { CommandDef, ToolRequirement } from "./types.ts";

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
		throw new TempoAbortError("docker not found -- install Docker first");
	}
	if (!hasDockerDaemon()) {
		throw new TempoAbortError(
			"Docker daemon is not running -- start Docker first",
		);
	}
}

interface NormalizedRequirement {
	tool: string;
	hint?: string;
}

/** Normalize a ToolRequirement to its object form */
function normalize(req: ToolRequirement): NormalizedRequirement {
	return typeof req === "string" ? { tool: req } : req;
}

/** Collect requires from subsystem + command definition, deduped. Command-level hints override subsystem-level. */
export function collectRequires(
	subsystemRequires: ToolRequirement[] | undefined,
	def: CommandDef,
): NormalizedRequirement[] {
	const cmdRequires: ToolRequirement[] | undefined =
		typeof def === "object" && !Array.isArray(def) ? def.requires : undefined;
	if (
		(subsystemRequires?.length ?? 0) === 0 &&
		(cmdRequires?.length ?? 0) === 0
	)
		return [];

	const map = new Map<string, NormalizedRequirement>();
	for (const req of subsystemRequires ?? []) {
		const n = normalize(req);
		map.set(n.tool, n);
	}
	// Command-level overrides subsystem-level hints
	for (const req of cmdRequires ?? []) {
		const n = normalize(req);
		map.set(n.tool, n);
	}
	return [...map.values()];
}

/** Return tool names from a requires list that are not on PATH */
export function getMissingTools(requires: string[]): string[] {
	return requires.filter((tool) => !hasTool(tool));
}

/** Return missing tool requirements (with hints) if any required tools are absent, null if all present */
export function checkMissingTools(
	subsystemRequires: ToolRequirement[] | undefined,
	def: CommandDef,
): NormalizedRequirement[] | null {
	const requires = collectRequires(subsystemRequires, def);
	if (requires.length === 0) return null;
	const missing = requires.filter((req) => !hasTool(req.tool));
	return missing.length > 0 ? missing : null;
}
