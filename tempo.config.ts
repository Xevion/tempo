import { defineConfig, task } from "./src/index.ts";

/** Every packaging check reads dist, so they all order behind one build. */
const build = task({
	name: "pkg:build",
	body: "bun run build",
	tags: ["build"],
	inputs: [
		"src/**/*.ts",
		"scripts/*.mjs",
		"package.json",
		"tsconfig.build.json",
	],
	outputs: ["dist/**/*.mjs", "dist/**/*.d.ts"],
});

export default defineConfig({
	tasks: [
		build,

		task({ name: "ts:type-check", body: "bunx tsc --noEmit", tags: ["check"] }),

		task({
			name: "biome:format",
			body: "bunx biome check --error-on-warnings .",
			tags: ["check"],
		}),
		task({
			name: "biome:format-fix",
			body: "bunx biome check --write --error-on-warnings .",
			tags: ["format"],
		}),
		task({
			name: "biome:lint",
			body: "bunx biome lint --error-on-warnings .",
			tags: ["check"],
		}),
		task({
			name: "biome:lint-fix",
			body: "bunx biome lint --write --error-on-warnings .",
			tags: ["format"],
			// Both writers touch the same files, so they must not run concurrently.
			after: ["biome:format-fix"],
		}),

		task({ name: "knip:check", body: "bunx knip", tags: ["check"] }),
		task({
			name: "typos:check",
			body: "typos",
			tags: ["check"],
			requires: [{ tool: "typos" }],
		}),

		task({
			name: "test:engine",
			body: "bun test tests/engine.test.ts",
			tags: ["check"],
		}),
		task({
			name: "test:cache",
			body: "bun test tests/cache.test.ts",
			tags: ["check"],
		}),
		task({
			name: "test:dev",
			body: "bun test tests/dev.test.ts",
			tags: ["check"],
		}),
		task({
			name: "test:smoke",
			body: "bun test tests/smoke.test.ts",
			tags: ["check"],
		}),
		task({
			name: "test:compat-bun",
			body: [
				"bun",
				"test",
				"tests/compat.test.ts",
				"--test-name-pattern",
				"cross-runtime: bun|no bun-specific",
			],
			tags: ["check"],
		}),
		task({
			name: "test:compat-node",
			body: [
				"bun",
				"test",
				"tests/compat.test.ts",
				"--test-name-pattern",
				"cross-runtime: node",
			],
			tags: ["check"],
			requires: [{ tool: "node" }],
		}),
		task({
			name: "test:compat-deno",
			body: [
				"bun",
				"test",
				"tests/compat.test.ts",
				"--test-name-pattern",
				"cross-runtime: deno",
			],
			tags: ["check"],
			requires: [{ tool: "deno" }],
		}),

		task({
			name: "ci:actionlint",
			body: "actionlint",
			tags: ["check"],
			requires: [{ tool: "actionlint" }],
		}),
		task({
			name: "ci:zizmor",
			body: "zizmor .github/",
			tags: ["check"],
			requires: [{ tool: "zizmor" }],
		}),

		task({ name: "pkg:audit", body: "bun audit", tags: ["check"] }),
		task({
			name: "pkg:pack",
			body: "npm pack --dry-run",
			tags: ["check"],
			needs: ["pkg:build"],
		}),
		task({
			name: "pkg:publint",
			body: "bunx publint --strict",
			tags: ["check"],
			needs: ["pkg:build"],
		}),
		task({
			name: "pkg:attw",
			body: "bunx @arethetypeswrong/cli --pack .",
			tags: ["check"],
			needs: ["pkg:build"],
		}),
	],

	commands: {
		check: { description: "Run every check in parallel", tags: ["check"] },
		fmt: {
			description: "Apply every formatter",
			tags: ["format"],
			concurrency: 1,
		},
		build: { description: "Build the package", tags: ["build"] },
	},
});
