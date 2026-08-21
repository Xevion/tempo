import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pkg from "../package.json" with { type: "json" };

/** Derive subpath names from package.json exports — single source of truth */
const SUBPATH_NAMES = Object.keys(pkg.exports)
	.filter((k) => k.startsWith("./") || k === ".")
	.map((k) => (k === "." ? "index" : k.slice(2)));

/** Register virtual modules so configs can import "@xevion/tempo" with no node_modules. */
export async function initRegistration(): Promise<void> {
	const selfDir = resolve(dirname(fileURLToPath(import.meta.url)));
	const isBun = "Bun" in globalThis;

	function resolveExportPath(name: string): string {
		if (isBun) {
			const srcDir = existsSync(join(selfDir, "index.ts"))
				? selfDir
				: resolve(selfDir, "..", "src");
			return join(srcDir, `${name}.ts`);
		}
		const distDir = existsSync(join(selfDir, "index.mjs"))
			? selfDir
			: resolve(selfDir, "..", "dist");
		return join(distDir, `${name}.mjs`);
	}

	const subpathExports: Record<string, string> = {};
	for (const name of SUBPATH_NAMES) {
		const specifier =
			name === "index" ? "@xevion/tempo" : `@xevion/tempo/${name}`;
		subpathExports[specifier] = resolveExportPath(name);
	}

	if (isBun) {
		const { plugin } = await import("bun");
		plugin({
			name: "tempo-self-resolve",
			setup(build) {
				for (const [specifier, filePath] of Object.entries(subpathExports)) {
					build.module(specifier, () => ({
						contents: `export * from "${filePath}";`,
						loader: "ts",
					}));
				}
			},
		});
	} else {
		const mod = await import("node:module");
		const mapping = Object.fromEntries(
			Object.entries(subpathExports).map(([spec, path]) => [
				spec,
				pathToFileURL(path).href,
			]),
		);

		// registerHooks runs in-thread and needs no serialized loader; register is deprecated.
		if (typeof mod.registerHooks === "function") {
			mod.registerHooks({
				resolve(specifier, context, nextResolve) {
					const url = mapping[specifier];
					return url
						? { url, shortCircuit: true }
						: nextResolve(specifier, context);
				},
			});
			return;
		}

		const loaderCode = `
			const mapping = ${JSON.stringify(mapping)};
			export function resolve(specifier, context, nextResolve) {
				if (mapping[specifier]) {
					return { url: mapping[specifier], shortCircuit: true };
				}
				return nextResolve(specifier, context);
			}
		`;
		mod.register(`data:text/javascript,${encodeURIComponent(loaderCode)}`);
	}
}
