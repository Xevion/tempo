import type { CommandFlagDef } from "./types.ts";

/** Parse argv against a flag spec, returning typed flags and leftover positional args */
export function parseFlagsFromArgv(
	spec: Record<string, CommandFlagDef>,
	args: string[],
): { flags: Record<string, unknown>; positional: string[] } {
	const flags: Record<string, unknown> = {};
	const positional: string[] = [];
	let i = 0;

	while (i < args.length) {
		const arg = args[i];
		if (arg === "--") {
			// Everything after -- is positional
			positional.push(...args.slice(i + 1));
			break;
		}

		if (arg.startsWith("--") || (arg.startsWith("-") && arg.length === 2)) {
			const flagName = arg.replace(/^-+/, "");

			let matchedName: string | undefined;
			let matchedDef: CommandFlagDef | undefined;
			for (const [name, def] of Object.entries(spec)) {
				if (name === flagName || def.alias === flagName) {
					matchedName = name;
					matchedDef = def;
					break;
				}
			}

			if (matchedDef && matchedName) {
				if (matchedDef.type === Boolean) {
					flags[matchedName] = true;
				} else {
					i++;
					const value = args[i];
					flags[matchedName] =
						matchedDef.type === Number ? Number(value) : value;
				}
			}
		} else {
			positional.push(arg);
		}
		i++;
	}

	// Apply defaults
	for (const [name, def] of Object.entries(spec)) {
		if (flags[name] === undefined && def.default !== undefined) {
			flags[name] = def.default;
		}
		if (flags[name] === undefined && def.type === Boolean) {
			flags[name] = false;
		}
	}

	return { flags, positional };
}
