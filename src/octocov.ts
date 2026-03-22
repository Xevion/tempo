import { readFileSync, writeFileSync, unlinkSync, rmdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPiped } from "./proc";

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
export function createOctocovConfig(repo: string): LocalConfig {
  const tmpDir = mkdtempSync(join(tmpdir(), "octocov-"));
  const configPath = join(tmpDir, ".octocov.yml");
  const eventPath = join(tmpDir, "event.json");

  // Read existing .octocov.yml and patch it
  let config: string;
  try {
    config = readFileSync(".octocov.yml", "utf-8");
  } catch {
    config = "";
  }

  // Replace artifact datastores with local paths
  const patched = config
    .replace(/datastore:\s*artifact:\/\/.*/g, `datastore: local://${tmpDir}`)
    .replace(
      /coverage:\s*\n/,
      `coverage:\n  datastore: local://${tmpDir}\n`,
    );

  writeFileSync(configPath, patched);

  // Create a minimal event.json for local runs
  const event = {
    repository: { full_name: repo },
    pull_request: null,
  };
  writeFileSync(eventPath, JSON.stringify(event));

  return {
    configPath,
    eventPath,
    env: {
      OCTOCOV_CONFIG: configPath,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: "push",
      GITHUB_REPOSITORY: repo,
    },
    cleanup: () => {
      try {
        unlinkSync(configPath);
        unlinkSync(eventPath);
        rmdirSync(tmpDir);
      } catch {
        // best-effort
      }
    },
  };
}

/** Discover Go packages that have test files */
export function testablePackages(): string[] {
  const result = runPiped("go list ./...");
  if (result.exitCode !== 0) return [];

  return result.stdout
    .trim()
    .split("\n")
    .filter((pkg) => {
      // Check if package directory has _test.go files
      const listResult = runPiped(`go list -f '{{.TestGoFiles}}' ${pkg}`);
      return (
        listResult.exitCode === 0 &&
        listResult.stdout.trim() !== "[]"
      );
    });
}
