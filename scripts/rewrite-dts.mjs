#!/usr/bin/env node
import { existsSync, globSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// TypeScript leaves `.ts` and extensionless relative specifiers in declaration
// output, neither of which node16 consumers can resolve.
const RELATIVE = /(from\s*|import\s*\(\s*)(["'])(\.{1,2}\/[^"']*)\2/g;

function rewriteSpecifier(dir, specifier) {
	if (specifier.endsWith(".ts")) return `${specifier.slice(0, -3)}.js`;
	if (/\.[cm]?jsx?$|\.json$/.test(specifier)) return specifier;
	if (existsSync(resolve(dir, `${specifier}.d.ts`))) return `${specifier}.js`;
	if (existsSync(resolve(dir, specifier, "index.d.ts"))) {
		return `${specifier}/index.js`;
	}
	return specifier;
}

let rewritten = 0;
for (const file of globSync("dist/**/*.d.ts")) {
	const dir = dirname(resolve(file));
	const source = readFileSync(file, "utf8");
	const next = source.replace(
		RELATIVE,
		(_match, head, quote, specifier) =>
			`${head}${quote}${rewriteSpecifier(dir, specifier)}${quote}`,
	);
	if (next === source) continue;
	writeFileSync(file, next);
	rewritten += 1;
}

process.stdout.write(`rewrote ${rewritten} declaration files\n`);
