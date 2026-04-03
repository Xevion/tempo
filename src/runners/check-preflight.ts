import { resolve } from "node:path";
import { TempoAbortError } from "../errors.ts";
import { ensureFresh, newestMtime } from "../preflight.ts";
import { run } from "../proc.ts";
import type {
	DeclarativePreflight,
	ResolvedConfig,
	TempoLogger,
} from "../types.ts";

function isDeclarativePreflight(p: unknown): p is DeclarativePreflight {
	return typeof p === "object" && p !== null && "label" in p;
}

/** Run all configured preflights, calling onStatus for spinner updates */
export async function runPreflights(
	config: ResolvedConfig,
	logger: TempoLogger,
	fail: (msg: string) => never,
	onStatus?: (label: string) => void,
): Promise<void> {
	for (const preflight of config.preflights ?? []) {
		if (isDeclarativePreflight(preflight)) {
			onStatus?.(preflight.label);
			const sourceMtime = newestMtime(
				resolve(config.rootDir, preflight.sources.dir),
				preflight.sources.pattern,
			);
			await ensureFresh({
				label: preflight.label,
				sourceMtime,
				artifactDir: resolve(config.rootDir, preflight.artifacts.dir),
				artifactGlob: preflight.artifacts.pattern,
				reason: preflight.reason,
				regenerate: async () => {
					if (typeof preflight.regenerate === "function") {
						await preflight.regenerate();
					} else {
						run(preflight.regenerate, { cwd: config.rootDir });
					}
				},
			});
		} else {
			try {
				await preflight({ logger, fail });
			} catch (e) {
				if (e instanceof TempoAbortError) throw e;
				throw e;
			}
		}
	}
}
