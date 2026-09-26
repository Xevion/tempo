import { createHash } from "node:crypto";
import {
	type Dirent,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
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

/**
 * A digest of each declared output's size and mtime, or null when some
 * pattern matches nothing at all.
 *
 * Stat rather than content, so a large artifact is never re-read just to learn
 * it was left alone. One walk covers both questions.
 */
export function statOutputs(root: string, patterns: string[]): string | null {
	if (patterns.length === 0) return "";

	const all: string[] = [];
	walk(root, root, all);
	const matchers = patterns.map(globToRegExp);
	if (!matchers.every((m) => all.some((file) => m.test(file)))) return null;

	const hash = createHash("sha256");
	for (const file of all
		.filter((p) => matchers.some((m) => m.test(p)))
		.sort()) {
		hash.update(file);
		try {
			const { size, mtimeMs } = statSync(resolve(root, file));
			hash.update(`\0${size}\0${mtimeMs}\0`);
		} catch {
			// Racing deletion counts as a change.
			hash.update("\0<missing>\0");
		}
	}
	return hash.digest("hex");
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

interface CacheRecord {
	fingerprint: string;
	/** Digest of the declared outputs as the task last left them. */
	outputs?: string;
}

function readRecord(root: string, name: string): CacheRecord | null {
	try {
		const raw = readFileSync(cacheFile(root, name), "utf8");
		const parsed = JSON.parse(raw) as Partial<CacheRecord>;
		if (!parsed.fingerprint) return null;
		return { fingerprint: parsed.fingerprint, outputs: parsed.outputs };
	} catch {
		return null;
	}
}

/** Record a completed task. Call only after its body succeeded. */
export function writeFingerprint(
	root: string,
	task: Task,
	value: string,
): void {
	const file = cacheFile(root, task.name);
	try {
		ensureWorkDir(root, "cache");
		const record: CacheRecord = {
			fingerprint: value,
			outputs: statOutputs(root, task.outputs ?? []) ?? undefined,
		};
		writeFileSync(file, `${JSON.stringify(record)}\n`);
	} catch {
		// A cache that cannot be written is a miss next time, not a failure.
	}
}

/** A task participates in caching only once it declares what it reads. */
export function isCacheable(task: Task): boolean {
	return (task.inputs?.length ?? 0) > 0;
}

/**
 * True when the inputs and the produced outputs are both unchanged.
 *
 * Comparing each output's size and mtime rather than its presence is what
 * keeps a hand edit to a generated file from surviving as a cache hit.
 */
export function isFresh(task: Task, root: string, current: string): boolean {
	const record = readRecord(root, task.name);
	if (!record || record.fingerprint !== current) return false;
	// Records written before outputs were digested have nothing to compare.
	if (record.outputs === undefined) return false;
	return record.outputs === statOutputs(root, task.outputs ?? []);
}
