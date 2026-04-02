import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { check, dev, preCommit, sequential } from "./runners/factories.ts";
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

// Register virtual modules so config files can `import from "@xevion/tempo"`
// without a project-level package.json or node_modules.
// Under Bun: resolve to src/*.ts (native TS support).
// Under Node: resolve to dist/*.mjs (pre-built JS, since Node can't strip
// types from files inside node_modules).
const selfDir = resolve(dirname(fileURLToPath(import.meta.url)));
const isBun = "Bun" in globalThis;

function resolveExportPath(name: string): string {
	if (isBun) {
		// Bun can load .ts directly — prefer src/
		const srcDir = existsSync(join(selfDir, "index.ts"))
			? selfDir
			: resolve(selfDir, "..", "src");
		return join(srcDir, `${name}.ts`);
	}
	// Node — use pre-built dist/*.mjs
	const distDir = existsSync(join(selfDir, "index.mjs"))
		? selfDir
		: resolve(selfDir, "..", "dist");
	return join(distDir, `${name}.mjs`);
}

const SUBPATH_NAMES = [
	"index",
	"proc",
	"fmt",
	"preflight",
	"targets",
	"watch",
	"octocov",
] as const;
const subpathExports: Record<string, string> = {};
for (const name of SUBPATH_NAMES) {
	const specifier =
		name === "index" ? "@xevion/tempo" : `@xevion/tempo/${name}`;
	subpathExports[specifier] = resolveExportPath(name);
}

if ("Bun" in globalThis) {
	const { plugin } = await import("bun");
	plugin({
		name: "tempo-self-resolve",
		setup(build) {
			for (const [specifier, filePath] of Object.entries(subpathExports)) {
				build.module(specifier, () => ({
					contents: `export * from "${filePath}";`,
					loader: "ts",
				}));
			}
		},
	});
} else {
	// Node.js: register a custom resolve hook via module.register()
	const { register } = await import("node:module");
	const mapping = Object.fromEntries(
		Object.entries(subpathExports).map(([spec, path]) => [
			spec,
			pathToFileURL(path).href,
		]),
	);
	const loaderCode = `
		const mapping = ${JSON.stringify(mapping)};
		export function resolve(specifier, context, nextResolve) {
			if (mapping[specifier]) {
				return { url: mapping[specifier], shortCircuit: true };
			}
			return nextResolve(specifier, context);
		}
	`;
	register(`data:text/javascript,${encodeURIComponent(loaderCode)}`);
}

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
		if (!isBun && isBunConfigError(error)) {
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
	return config;
}

async function enforceRuntime(config: TempoConfig): Promise<void> {
	if (config.runtime === "bun" && !isBun) {
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

/**
 * Build the resolved command tree from config.
 *
 * - Legacy mode (no `commands` key): auto-populate with built-in runners + custom entries.
 * - Explicit mode (`commands` present): use as-is, merge any `custom` entries not already in commands.
 */
function resolveCommands(config: TempoConfig): CommandTree {
	const hasExplicitCommands = config.commands !== undefined;

	if (!hasExplicitCommands) {
		// Legacy mode — auto-register all built-in runners + custom commands
		return {
			check: check(config.check),
			dev: dev(config.dev),
			fmt: sequential("format-apply", {
				description: "Sequential per-subsystem formatting",
				autoFixFallback: true,
				flags: config.fmt?.flags,
			}),
			lint: sequential("lint", {
				description: "Sequential per-subsystem linting",
				flags: config.lint?.flags,
			}),
			"pre-commit": preCommit(config.preCommit),
			...(config.custom ?? {}),
		};
	}

	// Explicit mode — commands wins, merge custom entries that don't conflict
	const tree: CommandTree = { ...config.commands };
	if (config.custom) {
		for (const [name, entry] of Object.entries(config.custom)) {
			if (!(name in tree)) {
				tree[name] = entry;
			}
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
		commands: resolveCommands(config),
	};
}
