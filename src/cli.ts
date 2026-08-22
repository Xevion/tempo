import { cli, command } from "cleye";
import pkg from "../package.json" with { type: "json" };
import { loadConfig } from "./config.ts";
import { Graph } from "./engine/graph.ts";
import { planLayers, run } from "./engine/schedule.ts";
import type { EventSink } from "./engine/types.ts";
import { GraphError } from "./engine/types.ts";
import { TempoAbortError, TempoConfigError } from "./errors.ts";
import { initRegistration } from "./register.ts";
import { jsonSink, ttySink } from "./render.ts";
import { reexecUnderBun, shouldReexec } from "./runtime.ts";
import type { CommandSpec, ResolvedConfig } from "./types.ts";
import { c } from "./utils/theme.ts";

interface GlobalFlags {
	configPath?: string;
	json: boolean;
	dryRun: boolean;
	noCache: boolean;
	concurrency?: number;
}

/** Apply a valueless global flag, reporting whether it matched. */
function applyBooleanFlag(arg: string, globals: GlobalFlags): boolean {
	if (arg === "--json") globals.json = true;
	else if (arg === "--dry-run") globals.dryRun = true;
	else if (arg === "--no-cache") globals.noCache = true;
	else return false;
	return true;
}

/** Apply a global flag that consumes the next argument. */
function applyValueFlag(
	arg: string,
	value: string | undefined,
	globals: GlobalFlags,
): boolean {
	if (arg === "--config") globals.configPath = value;
	else if (arg === "--concurrency" || arg === "-c") {
		globals.concurrency = Number(value);
	} else return false;
	return true;
}

/** Pull tempo's own flags out before cleye sees them, so `--` stays intact. */
function extractGlobals(argv: string[]): {
	globals: GlobalFlags;
	rest: string[];
	passthrough: string[];
} {
	const globals: GlobalFlags = {
		json: false,
		dryRun: false,
		noCache: false,
	};
	const rest: string[] = [];
	let passthrough: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		// Everything past `--` belongs to the task, not to tempo or cleye.
		if (arg === "--") {
			passthrough = argv.slice(i + 1);
			break;
		}
		if (applyBooleanFlag(arg, globals)) continue;
		if (applyValueFlag(arg, argv[i + 1], globals)) {
			i++;
			continue;
		}
		rest.push(arg);
	}
	return { globals, rest, passthrough };
}

/**
 * Narrow a selection by task name, tag, or namespace prefix.
 *
 * Dependencies are pulled back in afterwards: narrowing chooses what to run, and
 * running a task without what it needs would be a different thing entirely.
 */
function narrow(
	graph: Graph,
	runSet: Set<string>,
	targets: string[],
): Set<string> {
	if (targets.length === 0) return runSet;
	const wanted = new Set(targets);
	const kept = [...runSet].filter((name) => {
		const t = graph.tasks.get(name);
		if (!t) return false;
		return (
			t.always === true ||
			wanted.has(name) ||
			t.tags.some((tag) => wanted.has(tag)) ||
			targets.some((target) => name.startsWith(`${target}:`))
		);
	});
	const keptSet = new Set(kept);
	return graph.select((t) => keptSet.has(t.name));
}

function selectFor(graph: Graph, spec: CommandSpec): Set<string> {
	const selected = new Set<string>();
	for (const tag of spec.tags ?? []) {
		for (const name of graph.selectByTag(tag)) selected.add(name);
	}
	const named = spec.tasks ?? [];
	if (named.length > 0) {
		for (const name of graph.selectByName(named)) selected.add(name);
	}
	return selected;
}

function printPlan(graph: Graph, runSet: Set<string>): void {
	if (runSet.size === 0) {
		process.stderr.write("nothing selected\n");
		return;
	}
	for (const [index, layer] of planLayers(graph, runSet).entries()) {
		process.stderr.write(`${c.dim(`layer ${index + 1}`)}\n`);
		for (const name of layer) process.stderr.write(`  ${name}\n`);
	}
}

function listTasks(graph: Graph): void {
	for (const t of [...graph.tasks.values()].sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const tags = t.tags.length > 0 ? c.dim(` [${t.tags.join(", ")}]`) : "";
		const deps =
			t.needs.length > 0 ? c.dim(` needs ${t.needs.join(", ")}`) : "";
		process.stderr.write(`${t.name}${tags}${deps}\n`);
	}
}

async function execute(
	config: ResolvedConfig,
	graph: Graph,
	runSet: Set<string>,
	globals: GlobalFlags,
	spec?: CommandSpec,
	passthrough: string[] = [],
): Promise<number> {
	if (globals.dryRun) {
		printPlan(graph, runSet);
		return 0;
	}
	if (runSet.size === 0) {
		process.stderr.write("nothing selected\n");
		return 1;
	}

	const sink: EventSink = globals.json ? jsonSink() : ttySink();
	const controller = new AbortController();
	let interrupted = false;
	const onSignal = () => {
		interrupted = true;
		controller.abort();
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	try {
		const result = await run(graph, runSet, {
			concurrency: globals.concurrency ?? config.concurrency,
			requirementPolicy: config.isCI ? "fail" : undefined,
			rootDir: config.rootDir,
			cache: !globals.noCache,
			passthrough,
			exitBehavior: spec?.exitBehavior,
			signal: controller.signal,
			onEvent: sink,
		});
		// Interrupting a watch is a normal shutdown, not a failure.
		const persistent = [...runSet].some((n) => graph.get(n).persistent);
		if (interrupted && persistent) return 0;
		return result.ok ? 0 : 1;
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
}

/** Run one config command: its tags and tasks, narrowed by any positional targets. */
function runSelector(
	config: ResolvedConfig,
	graph: Graph,
	spec: CommandSpec,
	targets: string[],
	globals: GlobalFlags,
	passthrough: string[],
): Promise<number> {
	const selected = selectFor(graph, spec);
	const runSet = spec.passthrough ? selected : narrow(graph, selected, targets);
	return execute(
		config,
		graph,
		runSet,
		{ ...globals, concurrency: globals.concurrency ?? spec.concurrency },
		spec,
		spec.passthrough ? [...targets, ...passthrough] : passthrough,
	);
}

export async function main(
	argv: string[] = process.argv.slice(2),
): Promise<number> {
	const { globals, rest, passthrough } = extractGlobals(argv);

	// A bun project runs under bun, so configs may use bun-only APIs.
	if (shouldReexec()) reexecUnderBun();

	await initRegistration();

	let config: ResolvedConfig | null = null;
	let configError: unknown = null;
	try {
		config = await loadConfig({
			configPath: globals.configPath,
			json: globals.json,
		});
	} catch (err) {
		configError = err;
	}

	const specs = config?.commands ?? {};
	const commands = [
		...Object.entries(specs).map(([name, spec]) =>
			command({
				name,
				parameters: ["[targets...]"],
				help: { description: spec.description ?? `run tasks for ${name}` },
			}),
		),
		command({
			name: "list",
			help: { description: "list every task with its tags and dependencies" },
		}),
		command({
			name: "run",
			parameters: ["<tasks...>"],
			help: { description: "run specific tasks by name" },
		}),
	];

	const parsed = cli(
		{
			name: "tempo",
			version: pkg.version,
			commands,
			help: { description: "Developer task orchestrator" },
		},
		undefined,
		rest,
	);

	// A command was requested but no config could be loaded.
	if (!config) throw configError;

	const graph = new Graph(config.tasks);
	const name = parsed.command;

	if (name === "list") {
		listTasks(graph);
		return 0;
	}
	if (name === "run") {
		const wanted = (parsed._ as unknown as { tasks: string[] }).tasks ?? [];
		return execute(
			config,
			graph,
			graph.selectByName(wanted),
			globals,
			undefined,
			passthrough,
		);
	}
	if (name && specs[name]) {
		const targets =
			(parsed._ as unknown as { targets?: string[] }).targets ?? [];
		return runSelector(
			config,
			graph,
			specs[name],
			targets,
			globals,
			passthrough,
		);
	}

	// Naming a command this project does not define is the usual way an old hook fails.
	const attempted = (parsed._ as string[])[0];
	if (attempted) {
		const known = [...Object.keys(specs), "list", "run"].sort().join(", ");
		process.stderr.write(
			`${c.red("error")} no command "${attempted}"; this project defines ${known}\n`,
		);
		return 1;
	}

	parsed.showHelp();
	return 1;
}

/** Run main() and translate its known errors into a clean stderr message and exit code. */
export function runMain(): void {
	main()
		.then((code) => process.exit(code))
		.catch((err: unknown) => {
			if (
				err instanceof TempoConfigError ||
				err instanceof GraphError ||
				err instanceof TempoAbortError
			) {
				process.stderr.write(`${c.red("error")} ${err.message}\n`);
				process.exit(1);
			}
			throw err;
		});
}

if (import.meta.main) {
	runMain();
}
