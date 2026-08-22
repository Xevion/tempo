import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pkg from "../package.json" with { type: "json" };

type ExportConditions = Record<string, string>;

/**
 * Map every published specifier to the file that satisfies it under this runtime.
 *
 * The targets come from package.json rather than from the subpath's name, so a
 * `./engine` that lives at `engine/index.ts` resolves like any flat entrypoint.
 */
function exportTargets(packageRoot: string, isBun: boolean): ExportConditions {
	const targets: ExportConditions = {};
	for (const [subpath, conditions] of Object.entries(
		pkg.exports as Record<string, ExportConditions>,
	)) {
		const target = (isBun ? conditions.bun : undefined) ?? conditions.default;
		if (!target) continue;
		const specifier =
			subpath === "." ? pkg.name : `${pkg.name}${subpath.slice(1)}`;
		targets[specifier] = resolve(packageRoot, target);
	}
	return targets;
}

/**
 * True inside a `bun build --compile` binary, where `import.meta.url` is either a
 * non-addressable shared `$bunfs` path or a stale compile-machine path, so the
 * package-root math below cannot produce a usable virtual-module mapping.
 *
 * `isStandaloneExecutable` on the global Bun object postdates `@types/bun`, hence the cast.
 */
export function isStandaloneExecutable(): boolean {
	const bunGlobal = (
		globalThis as { Bun?: { isStandaloneExecutable?: boolean } }
	).Bun;
	return bunGlobal?.isStandaloneExecutable === true;
}

/**
 * Register virtual modules so configs can import "@xevion/tempo" with no node_modules.
 *
 * Inside a compiled binary, `register.standalone.ts` has already done this before
 * `main()` runs, using embedded bundle text rather than the path math below.
 */
export async function initRegistration(): Promise<void> {
	if (isStandaloneExecutable()) return;
	const isBun = "Bun" in globalThis;

	// This module ships in both src/ and dist/, so its parent is the package root either way.
	const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const subpathExports = exportTargets(packageRoot, isBun);

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
		return;
	}

	const mod = await import("node:module");
	const mapping = Object.fromEntries(
		Object.entries(subpathExports).map(([spec, path]) => [
			spec,
			pathToFileURL(path).href,
		]),
	);

	const published = Object.keys(mapping).sort().join(", ");

	// registerHooks runs in-thread and needs no serialized loader; register is deprecated.
	if (typeof mod.registerHooks === "function") {
		mod.registerHooks({
			resolve(specifier, context, nextResolve) {
				const url = mapping[specifier];
				if (url) return { url, shortCircuit: true };
				// Node would blame the package for a subpath it does not publish.
				if (specifier.startsWith(`${pkg.name}/`)) {
					throw new Error(
						`"${specifier}" is not published by ${pkg.name}; it exports ${published}`,
					);
				}
				return nextResolve(specifier, context);
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
			if (specifier.startsWith(${JSON.stringify(`${pkg.name}/`)})) {
				throw new Error(specifier + " is not published by ${pkg.name}; it exports ${published}");
			}
			return nextResolve(specifier, context);
		}
	`;
	mod.register(`data:text/javascript,${encodeURIComponent(loaderCode)}`);
}
