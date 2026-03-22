/** Thrown by validation functions for clean CLI error output. */
export class ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ValidationError";
	}
}

/** Parse an integer CLI option; throws a clear error if not a valid integer. */
export function parseIntOption(value: string, optionName = "value"): number {
	const n = Number.parseInt(value, 10);
	if (Number.isNaN(n)) {
		throw new ValidationError(
			`--${optionName} must be an integer, got: ${JSON.stringify(value)}`,
		);
	}
	return n;
}

/**
 * Resolve an enum CLI option with prefix matching.
 * - Exact match (case-insensitive) first
 * - Unambiguous prefix match second
 * - Ambiguous prefix → error listing matches
 * - No match → error listing all valid options
 */
export function resolveEnumOption<T extends string>(
	value: string,
	allowed: readonly T[],
	optionName = "value",
): T {
	const lower = value.toLowerCase();

	const exact = allowed.find((a) => a.toLowerCase() === lower);
	if (exact) return exact;

	const prefixMatches = allowed.filter((a) =>
		a.toLowerCase().startsWith(lower),
	);
	if (prefixMatches.length === 1) return prefixMatches[0] as T;
	if (prefixMatches.length > 1) {
		throw new ValidationError(
			`--${optionName} "${value}" is ambiguous: ${prefixMatches.join(", ")}`,
		);
	}

	throw new ValidationError(
		`--${optionName} must be one of: ${allowed.join(", ")}. Got: ${JSON.stringify(value)}`,
	);
}
