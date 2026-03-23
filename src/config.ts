import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { plugin } from "bun";
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

// Register virtual modules so config files can `import from "@xevion/tempo"`
// without a project-level package.json or node_modules.
// Uses build.module() which works for dynamic import() in current Bun versions,
// unlike onResolve() which only intercepts bundler-time resolution.
const tempoSrc = resolve(import.meta.dir);
const subpathExports: Record<string, string> = {
	"@xevion/tempo": join(tempoSrc, "index.ts"),
	"@xevion/tempo/proc": join(tempoSrc, "proc.ts"),
	"@xevion/tempo/fmt": join(tempoSrc, "fmt.ts"),
	"@xevion/tempo/preflight": join(tempoSrc, "preflight.ts"),
	"@xevion/tempo/targets": join(tempoSrc, "targets.ts"),
	"@xevion/tempo/watch": join(tempoSrc, "watch.ts"),
	"@xevion/tempo/octocov": join(tempoSrc, "octocov.ts"),
};

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

/** Load and resolve the tempo config from a file path or by auto-discovery */
export async function loadConfig(options?: {
	configPath?: string;
	cwd?: string;
}): Promise<ResolvedConfig> {
	const cwd = options?.cwd ?? process.cwd();

	let configPath: string;
	if (options?.configPath) {
		configPath = resolve(cwd, options.configPath);
		if (!existsSync(configPath)) {
			console.error(`Config file not found: ${configPath}`);
			process.exit(1);
		}
	} else {
		const discovered = discoverConfigPath(cwd);
		if (!discovered) {
			console.error(
				`Could not find ${CONFIG_FILENAME}. Create one in your project root or use --config <path>.`,
			);
			process.exit(1);
		}
		configPath = discovered;
	}

	const rootDir = dirname(configPath);

	const mod = await import(configPath);
	const config: TempoConfig = mod.default ?? mod;

	if (!config.subsystems || Object.keys(config.subsystems).length === 0) {
		console.error(
			`Invalid config: "subsystems" must be a non-empty object in ${configPath}`,
		);
		process.exit(1);
	}

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
		ci: {
			inject: { CI: "1" },
			groupedOutput: !!process.env.GITHUB_ACTIONS,
			...config.ci,
		},
		hooks: config.hooks ?? {},
		custom: config.custom ?? {},
	};
}
