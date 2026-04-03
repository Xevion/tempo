/** Thrown by ctx.fail() in hooks/preflights to abort with a message */
export class TempoAbortError extends Error {
	constructor(message?: string) {
		super(message);
		this.name = "TempoAbortError";
	}
}

/** Thrown when config loading, discovery, or validation fails */
export class TempoConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TempoConfigError";
	}
}

/** Thrown when an unknown subsystem target is specified */
export class TempoTargetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TempoTargetError";
	}
}

/** Thrown when a synchronous `run()` command exits with non-zero */
export class TempoRunError extends Error {
	readonly exitCode: number;

	constructor(exitCode: number) {
		super(`Command failed with exit code ${exitCode}`);
		this.name = "TempoRunError";
		this.exitCode = exitCode;
	}
}
