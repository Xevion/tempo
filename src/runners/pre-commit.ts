import { resolve, relative } from "node:path";
import type { ResolvedConfig, CommandDef } from "../types";
import { run, runPiped } from "../proc";
import { green, red, yellow, dim, parseArgs } from "../fmt";

export async function runPreCommit(config: ResolvedConfig): Promise<number> {
  // Get staged files
  const staged = runPiped("git diff --cached --name-only --diff-filter=ACMR");
  if (staged.exitCode !== 0) {
    process.stderr.write(`${red("failed to get staged files")}\n`);
    return 1;
  }

  const stagedFiles = staged.stdout.trim().split("\n").filter(Boolean);
  if (stagedFiles.length === 0) {
    process.stderr.write(`${dim("no staged files")}\n`);
    return 0;
  }

  // Detect partially staged files
  const unstaged = runPiped("git diff --name-only");
  const unstagedFiles = new Set(
    unstaged.stdout.trim().split("\n").filter(Boolean),
  );
  const partiallyStaged = new Set(
    stagedFiles.filter((f) => unstagedFiles.has(f)),
  );

  // Categorize files by subsystem (match against cwd prefixes)
  const subsystemNames = Object.keys(config.subsystems) as string[];
  const affectedSubsystems = new Map<string, string[]>();

  for (const file of stagedFiles) {
    for (const subsystem of subsystemNames) {
      const sub = config.subsystems[subsystem];
      if (sub.cwd) {
        if (file.startsWith(sub.cwd + "/") || file.startsWith(sub.cwd + "\\")) {
          const existing = affectedSubsystems.get(subsystem) ?? [];
          existing.push(file);
          affectedSubsystems.set(subsystem, existing);
          break;
        }
      } else {
        // No cwd = root-level subsystem, matches all unmatched files
        const existing = affectedSubsystems.get(subsystem) ?? [];
        existing.push(file);
        affectedSubsystems.set(subsystem, existing);
      }
    }
  }

  let hasFailure = false;

  for (const [subsystem, files] of affectedSubsystems) {
    const sub = config.subsystems[subsystem];
    if (!sub.commands) continue;

    const checkDef: CommandDef | undefined = sub.commands["format-check"];
    if (!checkDef) continue;

    const cwd = sub.cwd ? resolve(config.rootDir, sub.cwd) : config.rootDir;

    // Run format check
    let checkCmd: string[];
    if (typeof checkDef === "string") {
      checkCmd = parseArgs(checkDef);
    } else if (Array.isArray(checkDef)) {
      checkCmd = checkDef;
    } else {
      checkCmd = typeof checkDef.cmd === "string" ? parseArgs(checkDef.cmd) : checkDef.cmd;
    }

    const checkResult = runPiped(checkCmd, { cwd });

    if (checkResult.exitCode === 0) {
      process.stdout.write(`${green("✓")} ${dim(subsystem)} format check passed\n`);
      continue;
    }

    // Format check failed — try to auto-fix
    const fixAction = sub.autoFix?.["format-check"];
    if (!fixAction || !sub.commands[fixAction]) {
      process.stdout.write(`${red("✗")} ${dim(subsystem)} format check failed (no auto-fix available)\n`);
      hasFailure = true;
      continue;
    }

    const fixDef = sub.commands[fixAction];
    let fixCmd: string[];
    if (typeof fixDef === "string") {
      fixCmd = parseArgs(fixDef);
    } else if (Array.isArray(fixDef)) {
      fixCmd = fixDef;
    } else {
      fixCmd = typeof fixDef.cmd === "string" ? parseArgs(fixDef.cmd) : fixDef.cmd;
    }

    // Check for partial staging conflicts
    const conflictingFiles = files.filter((f) => partiallyStaged.has(f));
    if (conflictingFiles.length > 0) {
      process.stdout.write(
        `${yellow("⚠")} ${dim(subsystem)} has partially staged files that need formatting:\n`,
      );
      for (const f of conflictingFiles) {
        process.stdout.write(`  ${dim(f)}\n`);
      }
      process.stdout.write(
        `${dim("Please stage or stash your changes and run the formatter manually.")}\n`,
      );
      hasFailure = true;
      continue;
    }

    // Run formatter
    run(fixCmd, { cwd });

    // Re-stage formatted files
    for (const file of files) {
      runPiped(["git", "add", file]);
    }

    process.stdout.write(`${green("✓")} ${dim(subsystem)} auto-formatted and re-staged\n`);
  }

  return hasFailure ? 1 : 0;
}
