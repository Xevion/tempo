import { statSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { dim, cyan, green, yellow, elapsed } from "./fmt";

/** Scan a directory recursively and return the highest mtimeMs among matching files */
export function newestMtime(dir: string, pattern: string): number {
  if (!existsSync(dir)) return 0;

  const glob = new Bun.Glob(pattern);
  let newest = 0;

  for (const match of glob.scanSync({ cwd: dir })) {
    try {
      const stat = statSync(join(dir, match));
      if (stat.mtimeMs > newest) {
        newest = stat.mtimeMs;
      }
    } catch {
      // file may have been deleted between scan and stat
    }
  }

  return newest;
}

/** Check staleness and optionally regenerate. Returns true if regeneration ran. */
export function ensureFresh(opts: {
  label: string;
  sourceMtime: number;
  artifactDir: string;
  artifactGlob: string;
  reason?: string;
  regenerate: () => void;
}): boolean {
  const artifactMtime = newestMtime(opts.artifactDir, opts.artifactGlob);

  if (artifactMtime >= opts.sourceMtime) {
    process.stderr.write(
      `  ${dim("✓")} ${dim(opts.label)} ${dim("up-to-date, skipped")}\n`,
    );
    return false;
  }

  const reason = opts.reason ? ` (${opts.reason})` : "";
  process.stderr.write(
    `  ${cyan("↻")} Regenerating ${opts.label}...${dim(reason)}\n`,
  );

  const start = Date.now();
  const result: unknown = opts.regenerate();

  if (result && typeof result === "object" && "then" in result) {
    throw new Error(
      `ensureFresh called with async regenerate for "${opts.label}" — use ensureFreshAsync instead`,
    );
  }

  process.stderr.write(
    `  ${green("✓")} ${opts.label} ${dim(`(${elapsed(start)}s)`)}\n`,
  );
  return true;
}

/** Async variant of ensureFresh for async regenerate functions */
export async function ensureFreshAsync(opts: {
  label: string;
  sourceMtime: number;
  artifactDir: string;
  artifactGlob: string;
  reason?: string;
  regenerate: (() => void) | (() => Promise<void>);
}): Promise<boolean> {
  const artifactMtime = newestMtime(opts.artifactDir, opts.artifactGlob);

  if (artifactMtime >= opts.sourceMtime) {
    process.stderr.write(
      `  ${dim("✓")} ${dim(opts.label)} ${dim("up-to-date, skipped")}\n`,
    );
    return false;
  }

  const reason = opts.reason ? ` (${opts.reason})` : "";
  process.stderr.write(
    `  ${cyan("↻")} Regenerating ${opts.label}...${dim(reason)}\n`,
  );

  const start = Date.now();
  await opts.regenerate();

  process.stderr.write(
    `  ${green("✓")} ${opts.label} ${dim(`(${elapsed(start)}s)`)}\n`,
  );
  return true;
}
