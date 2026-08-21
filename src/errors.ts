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
