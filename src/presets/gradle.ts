import type { SubsystemConfig } from "../types.ts";

export interface GradlePresetOptions {
	cwd?: string;
	quiet?: boolean;
	configurationCache?: boolean;
	subprojects?: string[];
}

export function gradle(options?: GradlePresetOptions): SubsystemConfig {
	const quiet = options?.quiet ?? true;
	const configCache = options?.configurationCache ?? true;

	const flags: string[] = [];
	if (quiet) flags.push("--quiet");
	if (configCache) flags.push("--configuration-cache");
	const suffix = flags.length ? ` ${flags.join(" ")}` : "";

	const compileTargets =
		options?.subprojects
			?.map((sp) => `:${sp}:compileKotlin :${sp}:compileJava`)
			.join(" ") ?? "compileKotlin compileJava";

	return {
		aliases: ["gradle", "kt", "kotlin"],
		commands: {
			"format-check": `./gradlew spotlessCheck ktlintCheck${suffix}`,
			"format-apply": `./gradlew spotlessApply ktlintFormat${suffix}`,
			lint: `./gradlew detekt${suffix}`,
			compile: `./gradlew ${compileTargets}${suffix}`,
			test: `./gradlew test${suffix}`,
		},
		autoFix: {
			"format-check": "format-apply",
		},
	};
}
