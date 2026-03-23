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
