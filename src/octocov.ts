import {
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPiped } from "./proc";

/** The artifact datastore pattern used in CI .octocov.yml configs */
export const ARTIFACT_STORE = "artifact://${GITHUB_REPOSITORY}";

/** The local datastore path used for dev/local octocov runs */
export const LOCAL_STORE = "local://.octocov";

export interface LocalConfig {
	configPath: string;
	eventPath: string;
	env: Record<string, string>;
	cleanup: () => void;
}

/**
 * Create a local octocov config by patching .octocov.yml.
 * Replaces artifact:// datastores with local:// for dev.
 */
export function createOctocovConfig(
	repo: string,
	sourcePath = ".octocov.yml",
): LocalConfig {
	const text = readFileSync(sourcePath, "utf-8");
	const patched = text.replaceAll(ARTIFACT_STORE, LOCAL_STORE);

	const configPath = ".octocov-local.yml";
	const eventDir = mkdtempSync(join(tmpdir(), "octocov-event-"));
	const eventPath = join(eventDir, "event.json");

	writeFileSync(configPath, patched, "utf-8");
	writeFileSync(eventPath, "{}", "utf-8");

	return {
		configPath,
		eventPath,
		env: {
			GITHUB_REPOSITORY: repo,
			GITHUB_EVENT_NAME: "push",
			GITHUB_EVENT_PATH: eventPath,
		},
		cleanup: () => {
			try {
				unlinkSync(configPath);
			} catch {}
			try {
				rmSync(eventDir, { recursive: true });
			} catch {}
		},
	};
}

/**
 * Return Go package import paths that have test files.
 * Passing these explicitly to `go test` avoids printing 0%-coverage lines
 * for packages with no tests.
 */
export function testablePackages(): string[] {
	const result = runPiped([
		"go",
		"list",
		"-f",
		"{{if or .TestGoFiles .XTestGoFiles}}{{.ImportPath}}{{end}}",
		"./...",
	]);
	if (result.exitCode !== 0) return [];
	return result.stdout.trim().split("\n").filter(Boolean);
}
