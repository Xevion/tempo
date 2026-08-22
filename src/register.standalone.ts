import pkg from "../package.json" with { type: "json" };

/**
 * Registers a virtual module whose content is a self-contained bundle's own text,
 * embedded into the binary at compile time. A dynamically-imported external file (a
 * user's config) cannot resolve node_modules packages of its own inside a standalone
 * executable, so `@xevion/tempo` must arrive pre-bundled rather than as a path for
 * Bun to resolve.
 *
 * This file is only ever reachable from `cli.standalone.ts`'s build graph: importing
 * it from the ordinary `cli.ts` entry would embed the same text into `dist/cli.mjs`,
 * where it can never run.
 *
 * bun-types has no notion of `with { type: "text" }`, so each import below resolves
 * as an untyped `.mjs` module rather than the string it actually is at runtime.
 */
export async function registerStandaloneExecutable(): Promise<void> {
	const { plugin } = await import("bun");
	// @ts-expect-error -- see the doc comment above
	const indexMod = await import("../bin/embed/index.mjs", {
		with: { type: "text" },
	});
	// @ts-expect-error -- see the doc comment above
	const engineMod = await import("../bin/embed/engine/index.mjs", {
		with: { type: "text" },
	});
	// @ts-expect-error -- see the doc comment above
	const fmtMod = await import("../bin/embed/fmt.mjs", {
		with: { type: "text" },
	});
	const bundles: Record<string, string> = {
		[pkg.name]: (indexMod as { default: string }).default,
		[`${pkg.name}/engine`]: (engineMod as { default: string }).default,
		[`${pkg.name}/fmt`]: (fmtMod as { default: string }).default,
	};
	plugin({
		name: "tempo-self-resolve-standalone",
		setup(build) {
			for (const [specifier, contents] of Object.entries(bundles)) {
				build.module(specifier, () => ({ contents, loader: "js" }));
			}
		},
	});
}
