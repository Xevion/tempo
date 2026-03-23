import type { SubsystemConfig } from "../types.ts";

export interface RustPresetOptions {
	manifestPath?: string;
	features?: string[];
	allFeatures?: boolean;
	testFilter?: string;
	bin?: string;
}

export function rust(options?: RustPresetOptions): SubsystemConfig {
	const cargoFlags: string[] = [];
	if (options?.manifestPath) {
		cargoFlags.push("--manifest-path", options.manifestPath);
	}
	if (options?.allFeatures) {
		cargoFlags.push("--all-features");
	} else if (options?.features?.length) {
		cargoFlags.push("--features", options.features.join(","));
	}

	const extra = cargoFlags.length ? ` ${cargoFlags.join(" ")}` : "";

	let testCmd = `cargo nextest run${extra}`;
	if (options?.testFilter) {
		testCmd += ` -E '${options.testFilter}'`;
	}

	let buildCmd = `cargo build${extra}`;
	if (options?.bin) {
		buildCmd += ` --bin ${options.bin}`;
	}

	return {
		aliases: ["rust", "rs"],
		commands: {
			"format-check": `cargo fmt --check${extra}`,
			"format-apply": `cargo fmt${extra}`,
			lint: `cargo clippy --all-targets${extra} -- -D warnings`,
			test: testCmd,
			build: buildCmd,
		},
		autoFix: {
			"format-check": "format-apply",
		},
	};
}
