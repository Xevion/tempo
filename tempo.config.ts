import { defineConfig } from "./src/index.ts";

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
				"format-check": "bunx biome check .",
				"format-apply": "bunx biome check --write .",
			},
			autoFix: {
				"format-check": "format-apply",
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
	check: {
		autoFixStrategy: "fix-on-fail",
	},
});
