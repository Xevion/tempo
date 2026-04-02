import { defineConfig, runners } from "./src/index.ts";

export default defineConfig({
	subsystems: {
		ts: {
			aliases: ["typescript", "types"],
			commands: {
				"type-check": "bunx tsc --noEmit",
			},
		},
		biome: {
			aliases: ["lint", "web"],
			commands: {
				"format-check": "bunx biome check --error-on-warnings .",
				"format-apply": "bunx biome check --write --error-on-warnings .",
				"lint-check": "bunx biome lint --error-on-warnings .",
				"lint-apply": "bunx biome lint --write --error-on-warnings .",
			},
			autoFix: {
				"format-check": "format-apply",
				"lint-check": "lint-apply",
			},
		},
		knip: {
			aliases: ["deadcode"],
			commands: {
				check: "bunx knip",
			},
		},
		typos: {
			aliases: ["spelling"],
			commands: {
				check: { cmd: "typos", requires: ["typos"] },
			},
		},
		test: {
			aliases: ["tests"],
			commands: {
				smoke: "bun test tests/smoke.test.ts",
				"compat-bun":
					"bun test tests/compat.test.ts --test-name-pattern 'cross-runtime: bun|no bun-specific'",
				"compat-node": {
					cmd: "bun test tests/compat.test.ts --test-name-pattern 'cross-runtime: node'",
					requires: ["node"],
				},
				"compat-deno": {
					cmd: "bun test tests/compat.test.ts --test-name-pattern 'cross-runtime: deno'",
					requires: ["deno"],
				},
			},
		},
		ci: {
			aliases: ["actions"],
			commands: {
				actionlint: { cmd: "actionlint", requires: ["actionlint"] },
				zizmor: { cmd: "zizmor .github/", requires: ["zizmor"] },
			},
		},
		build: {
			commands: {
				build: "bun run build",
			},
		},
		pkg: {
			aliases: ["package", "publish"],
			commands: {
				audit: "bun audit",
				pack: "npm pack --dry-run",
				publint: "bunx publint --strict",
				attw: "bunx @arethetypeswrong/cli --pack .",
			},
		},
	},
	commands: {
		check: runners.check({ autoFixStrategy: "fix-on-fail" }),
		fmt: runners.sequential("format-apply", {
			description: "Sequential per-subsystem formatting",
			autoFixFallback: true,
		}),
		lint: runners.sequential("lint", {
			description: "Sequential per-subsystem linting",
		}),
		"pre-commit": runners.preCommit(),
	},
});
