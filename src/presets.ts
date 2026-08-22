import { task } from "./engine/graph.ts";
import type { Body, Requirement, Task } from "./engine/types.ts";
import { TempoConfigError } from "./errors.ts";

/**
 * A preset is a task generator, so what it returns is ordinary tasks.
 *
 * Nothing it produces is privileged: replace a body through `override`, drop one
 * with `false`, or ignore the preset entirely and write the tasks by hand.
 */
export interface PresetOptions {
	/** Prefix for generated task names. Defaults to the preset's own name. */
	name?: string;
	/** Directory to run in, resolved against the project root. */
	cwd?: string;
	/** Replace a generated body by its short name, or drop it with `false`. */
	override?: Record<string, Body | false>;
	/** Extra tags applied to every generated task. */
	tags?: string[];
	/** Lock every generated task against concurrent tempo runs. */
	lock?: boolean | string;
}

interface Entry {
	short: string;
	body: Body;
	tags: string[];
	requires?: Requirement[];
}

function generate(
	fallbackName: string,
	entries: Entry[],
	opts: PresetOptions | undefined,
): Task[] {
	const ns = opts?.name ?? fallbackName;
	const override = opts?.override ?? {};

	// An override naming no entry is a typo, not a request for a new task.
	for (const key of Object.keys(override)) {
		if (!entries.some((e) => e.short === key)) {
			const known = entries.map((e) => e.short).join(", ");
			throw new TempoConfigError(
				`preset "${ns}" has no task "${key}" to override (has ${known})`,
			);
		}
	}

	const out: Task[] = [];
	for (const entry of entries) {
		const body = Object.hasOwn(override, entry.short)
			? override[entry.short]
			: entry.body;
		if (body === false || body === undefined) continue;
		out.push(
			task({
				name: `${ns}:${entry.short}`,
				body,
				tags: [...entry.tags, ...(opts?.tags ?? [])],
				...(entry.requires && { requires: entry.requires }),
				...(opts?.cwd && { cwd: opts.cwd }),
				...(opts?.lock !== undefined && { lock: opts.lock }),
			}),
		);
	}
	return out;
}

export interface RustPresetOptions extends PresetOptions {
	manifestPath?: string;
	features?: string[];
	allFeatures?: boolean;
	testFilter?: string;
	bin?: string;
}

export function rust(options?: RustPresetOptions): Task[] {
	const flags: string[] = [];
	if (options?.manifestPath) {
		flags.push("--manifest-path", options.manifestPath);
	}
	if (options?.allFeatures) flags.push("--all-features");
	else if ((options?.features?.length ?? 0) > 0) {
		flags.push("--features", (options?.features ?? []).join(","));
	}
	const extra = flags.length > 0 ? ` ${flags.join(" ")}` : "";

	const test = options?.testFilter
		? `cargo nextest run${extra} -E '${options.testFilter}'`
		: `cargo nextest run${extra}`;
	const build = options?.bin
		? `cargo build${extra} --bin ${options.bin}`
		: `cargo build${extra}`;

	return generate(
		"rust",
		[
			{ short: "format", body: `cargo fmt --check${extra}`, tags: ["check"] },
			{ short: "format-fix", body: `cargo fmt${extra}`, tags: ["format"] },
			{
				short: "lint",
				body: `cargo clippy --all-targets${extra} -- -D warnings`,
				tags: ["check", "lint"],
			},
			{
				short: "test",
				body: test,
				tags: ["check", "test"],
				requires: [
					{ tool: "cargo-nextest", hint: "cargo install cargo-nextest" },
				],
			},
			{ short: "build", body: build, tags: ["build"] },
		],
		options,
	);
}

export interface BiomePresetOptions extends PresetOptions {
	/** Add a `type-check` task running the project's own `check` script. */
	svelte?: boolean;
	vitest?: boolean;
}

export function biome(options?: BiomePresetOptions): Task[] {
	const entries: Entry[] = [
		{ short: "format", body: "bunx biome check .", tags: ["check"] },
		{
			short: "format-fix",
			body: "bunx biome check --write .",
			tags: ["format"],
		},
		{ short: "lint", body: "bunx biome lint .", tags: ["check", "lint"] },
		{ short: "build", body: "bun run build", tags: ["build"] },
	];
	if (options?.svelte) {
		entries.push({
			short: "type-check",
			body: "bun run check",
			tags: ["check"],
		});
	}
	if (options?.vitest ?? options?.svelte ?? false) {
		entries.push({
			short: "test",
			body: "bunx vitest run",
			tags: ["check", "test"],
		});
	}
	return generate("web", entries, options);
}

export interface GoPresetOptions extends PresetOptions {
	race?: boolean;
	timeout?: string;
	buildTarget?: string;
}

export function go(options?: GoPresetOptions): Task[] {
	const timeout = options?.timeout ?? "5m";
	const buildTarget = options?.buildTarget ?? "./cmd/server";
	const testFlags = (options?.race ?? true) ? "-race -count=1" : "-count=1";

	return generate(
		"go",
		[
			{
				short: "format",
				body: ["sh", "-c", 'test -z "$(goimports -l .)"'],
				tags: ["check"],
				requires: [{ tool: "goimports" }],
			},
			{
				short: "format-fix",
				body: "goimports -w .",
				tags: ["format"],
				requires: [{ tool: "goimports" }],
			},
			{
				short: "lint",
				body: `golangci-lint run --timeout=${timeout}`,
				tags: ["check", "lint"],
				requires: [{ tool: "golangci-lint" }],
			},
			{
				short: "build",
				body: `go build -o /dev/null ${buildTarget}`,
				tags: ["build"],
			},
			{
				short: "test",
				body: `go test ${testFlags} ./...`,
				tags: ["check", "test"],
			},
		],
		options,
	);
}

export interface GradlePresetOptions extends PresetOptions {
	quiet?: boolean;
	configurationCache?: boolean;
	subprojects?: string[];
}

export function gradle(options?: GradlePresetOptions): Task[] {
	const flags: string[] = [];
	if (options?.quiet ?? true) flags.push("--quiet");
	if (options?.configurationCache ?? true) flags.push("--configuration-cache");
	const suffix = flags.length > 0 ? ` ${flags.join(" ")}` : "";

	const compileTargets =
		options?.subprojects
			?.map((sp) => `:${sp}:compileKotlin :${sp}:compileJava`)
			.join(" ") ?? "compileKotlin compileJava";

	return generate(
		"gradle",
		[
			{
				short: "format",
				body: `./gradlew spotlessCheck ktlintCheck${suffix}`,
				tags: ["check"],
			},
			{
				short: "format-fix",
				body: `./gradlew spotlessApply ktlintFormat${suffix}`,
				tags: ["format"],
			},
			{
				short: "lint",
				body: `./gradlew detekt${suffix}`,
				tags: ["check", "lint"],
			},
			{
				short: "compile",
				body: `./gradlew ${compileTargets}${suffix}`,
				tags: ["check"],
			},
			{
				short: "test",
				body: `./gradlew test${suffix}`,
				tags: ["check", "test"],
			},
		],
		options,
	);
}
