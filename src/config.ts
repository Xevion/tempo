import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CommandTree, ResolvedConfig, TempoConfig } from "./types.ts";

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
			console.error(`Config file not found: ${configPath}`);
			process.exit(1);
		}
		return configPath;
	}
	const discovered = discoverConfigPath(cwd);
	if (!discovered) {
		console.error(
			`Could not find ${CONFIG_FILENAME}. Create one in your project root or use --config <path>.`,
		);
		process.exit(1);
	}
	return discovered;
}

async function importConfig(configPath: string): Promise<TempoConfig> {
	let mod: Record<string, unknown>;
	try {
		mod = await import(configPath);
	} catch (error) {
		if (!("Bun" in globalThis) && isBunConfigError(error)) {
			console.error(
				`\nThis config appears to use Bun-specific imports, but tempo is running under Node.\n\n` +
					`To fix this, either:\n` +
					`  1. Add a bun.lock file to your project (run: bun install)\n` +
					`  2. Run directly with Bun: bun run tempo check\n` +
					`  3. Use bunx --bun: bunx --bun tempo check\n`,
			);
			process.exit(1);
		}
		throw error;
	}
	const config = (mod.default ?? mod) as TempoConfig;

	if (!config.subsystems || Object.keys(config.subsystems).length === 0) {
		console.error(
			`Invalid config: "subsystems" must be a non-empty object in ${configPath}`,
		);
		process.exit(1);
	}

	if (!config.commands || Object.keys(config.commands).length === 0) {
		console.error(
			`Invalid config: "commands" must be a non-empty object in ${configPath}.\n` +
				`Use runners.check(), runners.dev(), etc. to define commands.\n` +
				`See https://github.com/xevion/tempo for migration guide.`,
		);
		process.exit(1);
	}

	return config;
}

async function enforceRuntime(config: TempoConfig): Promise<void> {
	if (config.runtime === "bun" && !("Bun" in globalThis)) {
		const { isBunAvailable, reexecUnderBun } = await import("./runtime.ts");
		if (isBunAvailable()) {
			reexecUnderBun();
		} else {
			console.error(
				`Config specifies runtime: "bun" but bun is not installed.\n` +
					`Install Bun: https://bun.sh/docs/installation`,
			);
			process.exit(1);
		}
	}
}

/** Merge any custom entries not already present in the explicit command tree */
function mergeCustomCommands(
	commands: CommandTree,
	custom?: Record<string, unknown>,
): CommandTree {
	if (!custom) return commands;
	const tree: CommandTree = { ...commands };
	for (const [name, entry] of Object.entries(custom)) {
		if (!(name in tree)) {
			tree[name] = entry as CommandTree[string];
		}
	}
	return tree;
}

/** Load and resolve the tempo config from a file path or by auto-discovery */
export async function loadConfig(options?: {
	configPath?: string;
	cwd?: string;
}): Promise<ResolvedConfig> {
	const cwd = options?.cwd ?? process.cwd();
	const configPath = resolveConfigPath(cwd, options?.configPath);
	const rootDir = dirname(configPath);
	const config = await importConfig(configPath);
	await enforceRuntime(config);
	const isCI = detectCI(config);
	const commands = mergeCustomCommands(config.commands, config.custom);

	return {
		...config,
		configPath,
		rootDir,
		isCI,
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
		custom: config.custom ?? {},
		commands,
	};
}
