import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	type Dirent,
	lstatSync,
	readdirSync,
	readFileSync,
	renameSync,
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

const GLOB_CHARS = /[*?{]/;

/** True when the pattern names exactly one path. */
function isLiteral(pattern: string): boolean {
	return !GLOB_CHARS.test(pattern);
}

function isRegularFile(root: string, path: string): boolean {
	try {
		return lstatSync(resolve(root, path)).isFile();
	} catch {
		return false;
	}
}

function isDirectory(root: string, path: string): boolean {
	try {
		return lstatSync(resolve(root, path)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Every file a set of patterns could match, found by walking only below each
 * pattern's literal prefix.
 *
 * This is how outputs are found: they are routinely ignored build artifacts, so
 * a git listing would hide exactly the files that matter.
 */
function candidates(root: string, patterns: string[]): string[] {
	const found = new Set<string>();
	for (const pattern of patterns) {
		const segments = pattern.split("/");
		const at = segments.findIndex((s) => GLOB_CHARS.test(s));
		if (at === -1) {
			if (isRegularFile(root, pattern)) found.add(pattern);
			continue;
		}
		const below: string[] = [];
		walk(root, resolve(root, ...segments.slice(0, at)), below);
		for (const file of below) found.add(file);
	}
	return [...found];
}

/** Files git would list: tracked, or untracked and not ignored. Null outside a work tree. */
function gitFiles(root: string): string[] | null {
	const result = spawnSync(
		"git",
		["ls-files", "-co", "--exclude-standard", "-z"],
		{
			cwd: root,
			encoding: "utf8",
			maxBuffer: 1 << 28,
			stdio: ["ignore", "pipe", "ignore"],
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
		},
	);
	if (result.error || result.status !== 0) return null;
	const files = new Set<string>();
	for (const entry of result.stdout.split("\0")) {
		const path = entry.endsWith("/") ? entry.slice(0, -1) : entry;
		if (path === "" || path.split("/").some((s) => PRUNED.has(s))) continue;
		// A submodule or untracked nested repo is listed as the directory itself,
		// and git cannot say which of its files matter.
		if (isDirectory(root, path)) {
			const inside: string[] = [];
			walk(root, resolve(root, path), inside);
			for (const file of inside) files.add(file);
		} else files.add(path);
	}
	return [...files].sort();
}

/** A file this long untouched cannot change without its mtime moving. */
const SETTLE_MS = 2_000;
const INDEX_FILE = join(".tempo", "hashes.json");

interface FileDigest {
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	digest: string;
	/** Old enough that an edit within the same timestamp tick is impossible. */
	settled: boolean;
}

/**
 * The project's input files for one run: what exists, and what each contains.
 *
 * Inside a git work tree the listing comes from git, so ignored trees such as
 * `target/` are never descended into; elsewhere the project is walked. Digests
 * are remembered by size and timestamps, and persisted across runs, so a cached
 * task re-reads only the files that actually changed. That is a shortcut to the
 * same answer: a digest is always of content, and a file touched without being
 * edited is read once and then matches again.
 */
export class FileIndex {
	private listing: string[] | null = null;
	private digests: Map<string, FileDigest> | null = null;
	private dirty = false;
	private readonly seen = new Set<string>();

	private readonly root: string;
	private readonly settleMs: number;

	/** `settleMs` is how long a file must sit unchanged before its digest is trusted across runs. */
	constructor(root: string, settleMs = SETTLE_MS) {
		this.root = root;
		this.settleMs = settleMs;
	}

	/** Forget the listing, after something may have created or removed files. */
	invalidate(): void {
		this.listing = null;
	}

	/** Every candidate input file, as sorted `/`-separated relative paths. */
	files(): string[] {
		if (this.listing) return this.listing;
		let listing = gitFiles(this.root);
		// An empty answer may mean the root sits inside an ignored directory.
		if (listing === null || listing.length === 0) {
			listing = [];
			walk(this.root, this.root, listing);
			listing.sort();
		}
		this.listing = listing;
		return listing;
	}

	/**
	 * Files matching any pattern, sorted.
	 *
	 * A pattern with no wildcard names one file and is taken as written, so an
	 * ignored file can still be declared an input explicitly.
	 */
	match(patterns: string[]): string[] {
		if (patterns.length === 0) return [];
		const globs = patterns.filter((p) => !isLiteral(p)).map(globToRegExp);
		const found = new Set(
			globs.length === 0
				? []
				: this.files().filter((p) => globs.some((m) => m.test(p))),
		);
		for (const pattern of patterns) {
			if (isLiteral(pattern) && isRegularFile(this.root, pattern)) {
				found.add(pattern);
			}
		}
		return [...found].sort();
	}

	private load(): Map<string, FileDigest> {
		if (this.digests) return this.digests;
		this.digests = new Map();
		try {
			const raw = JSON.parse(
				readFileSync(join(this.root, INDEX_FILE), "utf8"),
			) as { files?: Record<string, [number, number, number, string]> };
			for (const [path, v] of Object.entries(raw.files ?? {})) {
				const [size, mtimeMs, ctimeMs, digest] = v;
				this.digests.set(path, {
					size,
					mtimeMs,
					ctimeMs,
					digest,
					settled: true,
				});
			}
		} catch {
			// no index yet, or one that cannot be trusted
		}
		return this.digests;
	}

	/** Content digest of a regular file, or null when it is gone or not one. */
	digest(file: string): string | null {
		const abs = resolve(this.root, file);
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(abs);
		} catch {
			return null;
		}
		if (!stat.isFile()) return null;
		this.seen.add(file);

		const known = this.load().get(file);
		if (
			known?.settled &&
			known.size === stat.size &&
			known.mtimeMs === stat.mtimeMs &&
			known.ctimeMs === stat.ctimeMs
		) {
			return known.digest;
		}

		let digest: string;
		try {
			digest = createHash("sha1").update(readFileSync(abs)).digest("hex");
		} catch {
			// Racing deletion counts as a change.
			return "<unreadable>";
		}
		const horizon = Date.now() - this.settleMs;
		this.load().set(file, {
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			ctimeMs: stat.ctimeMs,
			digest,
			settled: stat.mtimeMs < horizon && stat.ctimeMs < horizon,
		});
		this.dirty = true;
		return digest;
	}

	/** Persist the digests of settled files, dropping those no longer listed. */
	flush(): void {
		if (!this.dirty || !this.digests) return;
		const live = this.listing ? new Set(this.listing) : null;
		const files: Record<string, [number, number, number, string]> = {};
		for (const [path, d] of this.digests) {
			if (!d.settled) continue;
			if (live && !live.has(path) && !this.seen.has(path)) continue;
			files[path] = [d.size, d.mtimeMs, d.ctimeMs, d.digest];
		}
		const target = join(this.root, INDEX_FILE);
		try {
			ensureWorkDir(this.root);
			// Renamed into place so a concurrent tempo never reads half a file.
			const staging = `${target}.${process.pid}`;
			writeFileSync(staging, JSON.stringify({ files }));
			renameSync(staging, target);
			this.dirty = false;
		} catch {
			// An index that cannot be written costs a re-read next time.
		}
	}
}

/** Every file under `root` matching any pattern, as sorted relative paths. */
export function globFiles(
	root: string,
	patterns: string[],
	index: FileIndex = new FileIndex(root),
): string[] {
	return index.match(patterns);
}

/**
 * A digest of each declared output's size and mtime, or null when some
 * pattern matches nothing at all.
 *
 * Stat rather than content, so a large artifact is never re-read just to learn
 * it was left alone. Only the directories the patterns can reach are walked.
 */
export function statOutputs(root: string, patterns: string[]): string | null {
	if (patterns.length === 0) return "";

	const all = candidates(root, patterns);
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
export function fingerprint(
	task: Task,
	root: string,
	index: FileIndex = new FileIndex(root),
): string {
	const hash = createHash("sha256");
	hash.update(
		JSON.stringify({
			body: typeof task.body === "function" ? "fn" : task.body,
			cwd: task.cwd ?? null,
			env: task.env ?? null,
			outputs: task.outputs ?? [],
			key:
				typeof task.cacheKey === "function"
					? task.cacheKey()
					: (task.cacheKey ?? null),
		}),
	);

	for (const file of index.match(task.inputs ?? [])) {
		const digest = index.digest(file);
		if (digest !== null) hash.update(`${file}\0${digest}\n`);
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
