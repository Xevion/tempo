import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Captured, Requirement } from "./types.ts";

const SIGKILL_AFTER_MS = 3_000;
/**
 * Sequences a multiplexed pane cannot honour: whole-screen erases, scrollback
 * erases, cursor-home, and alt-screen switches. Vite clears the screen by
 * default, which would wipe every other process's output.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point
const SCREEN_CONTROL = /\x1b\[(?:[23]J|H|\?1049[hl])/g;
const DEATH_POLL_MS = 20;

/** Characters meaning a string genuinely needs a shell to interpret it. */
const SHELL_META = /[|&;<>()$`\\"'*?[\]~]/;
/** A leading `NAME=value` is an env assignment, which only a shell applies. */
const ENV_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Operators making a command a pipeline or list, which `exec` cannot replace. */
const SHELL_COMPOUND = /[|;&]/;

export interface ResolvedCommand {
	argv: string[];
	shell: boolean;
}

/**
 * A string body spawns directly unless it actually needs a shell.
 *
 * The common case (`cargo run -p server`) then has no intervening shell to
 * swallow SIGTERM, and the spawned process is literally the command.
 */
export function resolveArgv(body: string | string[]): ResolvedCommand {
	if (Array.isArray(body)) return { argv: body, shell: false };
	const trimmed = body.trim();
	if (trimmed === "") return { argv: ["sh", "-c", body], shell: true };
	if (!SHELL_META.test(trimmed) && !ENV_PREFIX.test(trimmed)) {
		return { argv: trimmed.split(/\s+/), shell: false };
	}
	// exec replaces the shell, so no wrapper survives to eat signals.
	const compound = SHELL_COMPOUND.test(trimmed);
	return {
		argv: ["sh", "-c", compound ? body : `exec ${body}`],
		shell: true,
	};
}

/** Locate an executable on PATH without spawning anything. */
export function hasTool(name: string): boolean {
	if (name.includes("/")) return existsSync(name);
	const path = process.env.PATH ?? "";
	for (const dir of path.split(delimiter)) {
		if (!dir) continue;
		try {
			accessSync(join(dir, name), constants.X_OK);
			return true;
		} catch {
			// not here
		}
	}
	return false;
}

export function missingRequirements(reqs: Requirement[]): Requirement[] {
	return reqs.filter((r) => {
		if (r.env) return !process.env[r.env]?.trim();
		if (r.file) return !existsSync(r.file);
		if (r.tool) return !hasTool(r.tool);
		return false;
	});
}

export function describeRequirement(r: Requirement): string {
	const what = r.tool ?? (r.env && `$${r.env}`) ?? r.file ?? "requirement";
	return r.hint ? `${what} (${r.hint})` : what;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SpawnOptions {
	cwd?: string;
	env?: Record<string, string>;
	/** Ask the child for colour even though its stdout is a pipe. */
	color?: boolean;
	signal: AbortSignal;
	onLine?: (stream: "stdout" | "stderr", line: string) => void;
	capture?: boolean;
}

export interface ExitStatus {
	code: number | null;
	signal: NodeJS.Signals | null;
}

/**
 * A child process bound to a scope, disposed deterministically by `await using`.
 *
 * Node's own `signal` spawn option is deliberately unused: it kills only the
 * direct child and races this class's process-group kill, and the loser's
 * `exited` promise settles by rejection, cancelling the SIGKILL escalation.
 * Termination has exactly one owner.
 */
export class Spawned implements AsyncDisposable {
	readonly exited: Promise<ExitStatus>;
	private readonly child: ChildProcess;
	private readonly abortListener: () => void;
	private readonly signal: AbortSignal;
	private reaped = false;
	private stdout = "";
	private stderr = "";

	constructor(argv: string[], opts: SpawnOptions) {
		const [command, ...args] = argv;
		if (!command) throw new Error("empty command");

		this.signal = opts.signal;
		this.child = spawn(command, args, {
			cwd: opts.cwd,
			env: {
				...process.env,
				// A pipe makes tools drop colour; ask for it back explicitly.
				...(opts.color ? { FORCE_COLOR: "1", CLICOLOR_FORCE: "1" } : {}),
				...opts.env,
			},
			stdio: ["ignore", "pipe", "pipe"],
			// Lead a process group so a signal reaches grandchildren too.
			detached: true,
		});

		this.pipe("stdout", opts);
		this.pipe("stderr", opts);

		this.exited = new Promise((resolve, reject) => {
			this.child.once("exit", (code, signal) => {
				this.reaped = true;
				resolve({ code, signal });
			});
			// A missing binary is otherwise an unhandled error event that takes
			// down every sibling mid-flight.
			this.child.once("error", (err) => {
				this.reaped = true;
				reject(err);
			});
		});

		this.abortListener = () => this.signalGroup("SIGTERM");
		if (opts.signal.aborted) this.abortListener();
		else
			opts.signal.addEventListener("abort", this.abortListener, { once: true });
	}

	private pipe(stream: "stdout" | "stderr", opts: SpawnOptions): void {
		const source = this.child[stream];
		if (!source) return;
		let buffered = "";
		source.setEncoding("utf8");
		source.on("data", (raw: string) => {
			const chunk = raw.replace(SCREEN_CONTROL, "");
			if (opts.capture) {
				if (stream === "stdout") this.stdout += chunk;
				else this.stderr += chunk;
			}
			if (!opts.onLine) return;
			buffered += chunk;
			const lines = buffered.split("\n");
			buffered = lines.pop() ?? "";
			for (const line of lines) opts.onLine(stream, line);
		});
		source.on("end", () => {
			if (buffered && opts.onLine) opts.onLine(stream, buffered);
		});
	}

	get output(): { stdout: string; stderr: string } {
		return { stdout: this.stdout, stderr: this.stderr };
	}

	private signalGroup(sig: NodeJS.Signals): void {
		if (this.reaped || !this.child.pid) return;
		try {
			process.kill(-this.child.pid, sig);
		} catch {
			// group already gone
		}
	}

	private alive(): boolean {
		if (this.reaped || !this.child.pid) return false;
		try {
			process.kill(this.child.pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	async [Symbol.asyncDispose](): Promise<void> {
		this.signal.removeEventListener("abort", this.abortListener);
		if (!this.alive()) return;
		this.signalGroup("SIGTERM");
		// Poll for actual death rather than awaiting `exited`, which may have
		// settled by rejection while the process is still running.
		const deadline = Date.now() + SIGKILL_AFTER_MS;
		while (this.alive() && Date.now() < deadline) await sleep(DEATH_POLL_MS);
		if (!this.alive()) return;
		this.signalGroup("SIGKILL");
		const hard = Date.now() + SIGKILL_AFTER_MS;
		while (this.alive() && Date.now() < hard) await sleep(DEATH_POLL_MS);
	}
}

/** Signal deaths stay distinguishable instead of collapsing into 1. */
export function exitCode(status: ExitStatus): number {
	if (status.signal) {
		const offset =
			status.signal === "SIGINT" ? 2 : status.signal === "SIGTERM" ? 15 : 1;
		return 128 + offset;
	}
	return status.code ?? 1;
}

export async function captureCommand(
	body: string | string[],
	opts: SpawnOptions,
): Promise<Captured> {
	const { argv } = resolveArgv(body);
	await using proc = new Spawned(argv, { ...opts, capture: true });
	const status = await proc.exited;
	const { stdout, stderr } = proc.output;
	return { stdout, stderr, code: exitCode(status) };
}
