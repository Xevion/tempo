import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TempoConfigError } from "./errors.ts";
import { isStandaloneExecutable } from "./register.ts";
import type { ResolvedConfig, TempoConfig } from "./types.ts";

const CONFIG_FILENAME = "tempo.config.ts";

const CI_ENV_VARS = [
	"CI",
	"GITHUB_ACTIONS",
	"GITLAB_CI",
	"CIRCLECI",
	"JENKINS_URL",
	"BUILDKITE",
];

function isBunConfigError(error: unknown): boolean {
	const msg = error instanceof Error ? error.message : String(error);
	return (
		/Cannot find (?:module|package) ['"]bun['"]/.test(msg) ||
		msg.includes("ERR_MODULE_NOT_FOUND") ||
		/from ['"]bun['"]/.test(msg)
	);
}

const MISSING_SPECIFIER = /Cannot find (?:module|package) ['"]([^'"]+)['"]/;

/**
 * A compiled binary embeds @xevion/tempo itself but has no node_modules of its
 * own, so a config's import of anything else fails to resolve at all.
 */
function standaloneUnresolvedImport(error: unknown): string | null {
	if (!isStandaloneExecutable()) return null;
	const msg = error instanceof Error ? error.message : String(error);
	return MISSING_SPECIFIER.exec(msg)?.[1] ?? null;
}

/** Walk up from cwd looking for a config file. */
function discoverConfigPath(startDir: string): string | null {
	let dir = resolve(startDir);
	const root = resolve("/");
	while (true) {
		const candidate = resolve(dir, CONFIG_FILENAME);
		if (existsSync(candidate)) return candidate;
		if (dir === root) return null;
		dir = dirname(dir);
	}
}

function resolveConfigPath(cwd: string, explicitPath?: string): string {
	if (explicitPath) {
		const configPath = resolve(cwd, explicitPath);
		if (!existsSync(configPath)) {
			throw new TempoConfigError(`config file not found: ${configPath}`);
		}
		return configPath;
	}
	const discovered = discoverConfigPath(cwd);
	if (!discovered) {
		throw new TempoConfigError(
			`could not find ${CONFIG_FILENAME}; create one in your project root or pass --config <path>`,
		);
	}
	return discovered;
}

async function importConfig(configPath: string): Promise<TempoConfig> {
	let mod: Record<string, unknown>;
	try {
		mod = await import(configPath);
	} catch (error) {
		if (!("Bun" in globalThis) && isBunConfigError(error)) {
			throw new TempoConfigError(
				`this config uses bun-specific imports but tempo is running under node; add a bun.lock or run it with bun`,
			);
		}
		const unresolved = standaloneUnresolvedImport(error);
		if (unresolved) {
			throw new TempoConfigError(
				`this config imports "${unresolved}", which the compiled tempo binary cannot resolve; ` +
					`it bundles @xevion/tempo (and node:* builtins) but has no node_modules of its own. ` +
					`Install tempo from npm and run it with bun, node, or deno instead.`,
			);
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new TempoConfigError(`failed to load ${configPath}: ${message}`);
	}

	const config = (mod.default ?? mod) as TempoConfig;
	if (!Array.isArray(config.tasks) || config.tasks.length === 0) {
		throw new TempoConfigError(
			`invalid config: "tasks" must be a non-empty array in ${configPath}`,
		);
	}
	return config;
}

async function enforceRuntime(config: TempoConfig): Promise<void> {
	if (config.runtime !== "bun" || "Bun" in globalThis) return;
	const { isBunAvailable, reexecUnderBun } = await import("./runtime.ts");
	if (!isBunAvailable()) {
		throw new TempoConfigError(
			`config requests runtime "bun" but bun is not installed`,
		);
	}
	reexecUnderBun();
}

export async function loadConfig(options?: {
	configPath?: string;
	cwd?: string;
	json?: boolean;
}): Promise<ResolvedConfig> {
	const cwd = options?.cwd ?? process.cwd();
	const configPath = resolveConfigPath(cwd, options?.configPath);
	const config = await importConfig(configPath);
	await enforceRuntime(config);

	return {
		...config,
		configPath,
		rootDir: dirname(configPath),
		isCI: CI_ENV_VARS.some((v) => process.env[v]),
		json: options?.json ?? false,
	};
}
