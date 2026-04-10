import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getLogger } from "@logtape/logtape";
import { TempoConfigError } from "./errors.ts";
import type { ResolvedConfig, TempoConfig } from "./types.ts";
import { FORMAT_CHECK } from "./types.ts";

const CONFIG_FILENAME = "tempo.config.ts";
const logger = getLogger(["tempo", "config"]);

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

function detectCI(config: TempoConfig): boolean {
	if (config.ci?.enabled !== undefined) return config.ci.enabled;
	return CI_ENV_VARS.some((v) => process.env[v]);
}

/** Walk up from cwd to find tempo.config.ts */
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
			throw new TempoConfigError(`Config file not found: ${configPath}`);
		}
		return configPath;
	}
	const discovered = discoverConfigPath(cwd);
	if (!discovered) {
		throw new TempoConfigError(
			`Could not find ${CONFIG_FILENAME}. Create one in your project root or use --config <path>.`,
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
				`This config appears to use Bun-specific imports, but tempo is running under Node.\n\n` +
					`To fix this, either:\n` +
					`  1. Add a bun.lock file to your project (run: bun install)\n` +
					`  2. Run directly with Bun: bun run tempo check\n` +
					`  3. Use bunx --bun: bunx --bun tempo check`,
			);
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new TempoConfigError(
			`Failed to load config at ${configPath}: ${message}`,
		);
	}
	const config = (mod.default ?? mod) as TempoConfig;

	if (!config.subsystems || Object.keys(config.subsystems).length === 0) {
		throw new TempoConfigError(
			`Invalid config: "subsystems" must be a non-empty object in ${configPath}`,
		);
	}

	if (!config.commands || Object.keys(config.commands).length === 0) {
		throw new TempoConfigError(
			`Invalid config: "commands" must be a non-empty object in ${configPath}.\n` +
				`Use runners.check(), runners.dev(), etc. to define commands.\n` +
				`See https://github.com/xevion/tempo for migration guide.`,
		);
	}

	return config;
}

/** Warn if subsystems declare autoFix with format-check but don't have the required commands */
function validateFormatProtocol(config: TempoConfig): void {
	if (!config.preCommit) return;
	for (const [name, sub] of Object.entries(config.subsystems)) {
		if (!sub.autoFix?.[FORMAT_CHECK]) continue;
		if (!sub.commands?.[FORMAT_CHECK]) {
			logger.warn(
				"subsystem '{name}' has autoFix['{key}'] but no '{key}' command — pre-commit will skip this subsystem",
				{ name, key: FORMAT_CHECK },
			);
		}
		const fixTarget = sub.autoFix[FORMAT_CHECK];
		if (fixTarget && !sub.commands?.[fixTarget]) {
			logger.warn(
				"subsystem '{name}' autoFix maps '{key}' → '{target}', but '{target}' command does not exist",
				{ name, key: FORMAT_CHECK, target: fixTarget },
			);
		}
	}
}

async function enforceRuntime(config: TempoConfig): Promise<void> {
	if (config.runtime === "bun" && !("Bun" in globalThis)) {
		const { isBunAvailable, reexecUnderBun } = await import("./runtime.ts");
		if (isBunAvailable()) {
			reexecUnderBun();
		} else {
			throw new TempoConfigError(
				`Config specifies runtime: "bun" but bun is not installed.\n` +
					`Install Bun: https://bun.sh/docs/installation`,
			);
		}
	}
}

/** Load and resolve the tempo config from a file path or by auto-discovery */
export async function loadConfig(options?: {
	configPath?: string;
	cwd?: string;
	json?: boolean;
}): Promise<ResolvedConfig> {
	const cwd = options?.cwd ?? process.cwd();
	const configPath = resolveConfigPath(cwd, options?.configPath);
	const rootDir = dirname(configPath);
	const config = await importConfig(configPath);
	validateFormatProtocol(config);
	await enforceRuntime(config);
	const isCI = detectCI(config);

	return {
		...config,
		configPath,
		rootDir,
		isCI,
		json: options?.json ?? false,
		preflights: config.preflights ?? [],
		check: {
			autoFixStrategy: "fix-first",
			...config.check,
		},
		dev: {
			exitBehavior: "first-exits",
			...config.dev,
		},
		fmt: config.fmt ?? {},
		lint: config.lint ?? {},
		preCommit: config.preCommit ?? {},
		ci: {
			inject: { CI: "1" },
			groupedOutput: !!process.env.GITHUB_ACTIONS,
			...config.ci,
		},
		hooks: config.hooks ?? {},
		commands: config.commands,
	};
}
