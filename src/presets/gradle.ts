import { FORMAT_APPLY, FORMAT_CHECK, type SubsystemConfig } from "../types.ts";

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
	const suffix = flags.length > 0 ? ` ${flags.join(" ")}` : "";

	const compileTargets =
		options?.subprojects
			?.map((sp) => `:${sp}:compileKotlin :${sp}:compileJava`)
			.join(" ") ?? "compileKotlin compileJava";

	return {
		aliases: ["gradle", "kt", "kotlin"],
		commands: {
			[FORMAT_CHECK]: `./gradlew spotlessCheck ktlintCheck${suffix}`,
			[FORMAT_APPLY]: `./gradlew spotlessApply ktlintFormat${suffix}`,
			lint: `./gradlew detekt${suffix}`,
			compile: `./gradlew ${compileTargets}${suffix}`,
			test: `./gradlew test${suffix}`,
		},
		autoFix: {
			[FORMAT_CHECK]: FORMAT_APPLY,
		},
	};
}
