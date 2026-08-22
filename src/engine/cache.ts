import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Task } from "./types.ts";
import { ensureWorkDir } from "./workdir.ts";

/** Directories never worth walking for inputs or outputs. */
const PRUNED = new Set(["node_modules", ".git", ".tempo"]);

const CACHE_DIR = join(".tempo", "cache");

/** Expand `*` or `**` at `index`, with the number of characters consumed. */
function expandStar(
	pattern: string,
	index: number,
): { fragment: string; consumed: number } {
	if (pattern[index + 1] !== "*") return { fragment: "[^/]*", consumed: 1 };
	// `**/` may match zero directories, so the separator is optional.
	if (pattern[index + 2] === "/") {
		return { fragment: "(?:[^/]+/)*", consumed: 3 };
	}
	return { fragment: ".*", consumed: 2 };
}

interface GlobState {
	out: string;
	braces: number;
}

/** Translate one non-star character, tracking brace alternation depth. */
function translateChar(ch: string, state: GlobState): void {
	if (ch === "?") state.out += "[^/]";
	else if (ch === "{") {
		state.braces++;
		state.out += "(?:";
	} else if (ch === "}" && state.braces > 0) {
		state.braces--;
		state.out += ")";
	} else if (ch === "," && state.braces > 0) state.out += "|";
	else state.out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Translate a glob to an anchored RegExp over `/`-separated paths. */
export function globToRegExp(pattern: string): RegExp {
	const state: GlobState = { out: "", braces: 0 };

	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === undefined) continue;
		if (ch === "*") {
			const { fragment, consumed } = expandStar(pattern, i);
			state.out += fragment;
			i += consumed - 1;
			continue;
		}
		translateChar(ch, state);
	}
	return new RegExp(`^${state.out}$`);
}

function walk(root: string, dir: string, found: string[]): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (PRUNED.has(entry.name)) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(root, full, found);
		else if (entry.isFile())
			found.push(relative(root, full).split(sep).join("/"));
	}
}

/** Every file under `root` matching any pattern, as sorted relative paths. */
export function globFiles(root: string, patterns: string[]): string[] {
	if (patterns.length === 0) return [];
	const matchers = patterns.map(globToRegExp);
	const all: string[] = [];
	walk(root, root, all);
	return all.filter((p) => matchers.some((m) => m.test(p))).sort();
}

/** True when every declared output pattern matches at least one file. */
export function outputsPresent(root: string, patterns: string[]): boolean {
	if (patterns.length === 0) return true;
	const all: string[] = [];
	walk(root, root, all);
	return patterns
		.map(globToRegExp)
		.every((m) => all.some((file) => m.test(file)));
}

/**
 * A fingerprint over the task's definition and the contents of its inputs.
 *
 * Content rather than mtime, so a touched-but-unchanged file is still a hit and
 * a restored checkout is not a spurious miss.
 */
export function fingerprint(task: Task, root: string): string {
	const hash = createHash("sha256");
	hash.update(
		JSON.stringify({
			body: typeof task.body === "function" ? "fn" : task.body,
			cwd: task.cwd ?? null,
			env: task.env ?? null,
			outputs: task.outputs ?? [],
		}),
	);

	for (const file of globFiles(root, task.inputs ?? [])) {
		hash.update(file);
		try {
			hash.update(readFileSync(resolve(root, file)));
		} catch {
			// Racing deletion counts as a change.
			hash.update("<unreadable>");
		}
	}
	return hash.digest("hex");
}

function cacheFile(root: string, name: string): string {
	const safe = name.replace(/[^A-Za-z0-9._-]/g, "_");
	return join(root, CACHE_DIR, `${safe}.json`);
}

export function readFingerprint(root: string, name: string): string | null {
	try {
		const raw = readFileSync(cacheFile(root, name), "utf8");
		const parsed = JSON.parse(raw) as { fingerprint?: string };
		return parsed.fingerprint ?? null;
	} catch {
		return null;
	}
}

export function writeFingerprint(
	root: string,
	name: string,
	value: string,
): void {
	const file = cacheFile(root, name);
	try {
		ensureWorkDir(root, "cache");
		writeFileSync(file, `${JSON.stringify({ fingerprint: value })}\n`);
	} catch {
		// A cache that cannot be written is a miss next time, not a failure.
	}
}

/** A task participates in caching only once it declares what it reads. */
export function isCacheable(task: Task): boolean {
	return (task.inputs?.length ?? 0) > 0;
}

/** True when the stored fingerprint matches and the declared outputs exist. */
export function isFresh(task: Task, root: string, current: string): boolean {
	if (readFingerprint(root, task.name) !== current) return false;
	return outputsPresent(root, task.outputs ?? []);
}
