import { getLogger } from "@logtape/logtape";
import { c } from "../fmt.ts";
import { run, runPiped } from "../proc.ts";
import { resolveCommandDef, resolveCwd } from "../resolve.ts";
import { checkMissingTools } from "../tools.ts";
import type { CommandDef, ResolvedConfig } from "../types.ts";
import { FORMAT_CHECK } from "../types.ts";

const logger = getLogger(["tempo", "pre-commit"]);

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pre-commit flow with partial staging detection
export async function runPreCommit(
	config: ResolvedConfig,
	_flags: Record<string, unknown>,
): Promise<number> {
	// Get staged files
	const staged = runPiped("git diff --cached --name-only --diff-filter=ACMR");
	if (staged.exitCode !== 0) {
		logger.error("failed to get staged files");
		return 1;
	}

	const stagedFiles = staged.stdout.trim().split("\n").filter(Boolean);
	if (stagedFiles.length === 0) {
		logger.info("no staged files");
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
	const subsystemNames = Object.keys(config.subsystems);
	const affectedSubsystems = new Map<string, string[]>();

	for (const file of stagedFiles) {
		for (const subsystem of subsystemNames) {
			const sub = config.subsystems[subsystem];
			if (sub?.cwd) {
				if (file.startsWith(`${sub.cwd}/`) || file.startsWith(`${sub.cwd}\\`)) {
					const existing = affectedSubsystems.get(subsystem) ?? [];
					existing.push(file);
					affectedSubsystems.set(subsystem, existing);
					break;
				}
			} else {
				const existing = affectedSubsystems.get(subsystem) ?? [];
				existing.push(file);
				affectedSubsystems.set(subsystem, existing);
			}
		}
	}

	let hasFailure = false;

	for (const [subsystem, files] of affectedSubsystems) {
		const sub = config.subsystems[subsystem];
		if (!sub?.commands) continue;

		const checkDef: CommandDef | undefined = sub.commands[FORMAT_CHECK];
		if (!checkDef) continue;

		if (checkMissingTools(sub.requires, checkDef)) continue;

		const cwd = resolveCwd(config.rootDir, undefined, sub.cwd);
		const { cmd: checkCmd } = resolveCommandDef(checkDef);
		const checkResult = runPiped(checkCmd, { cwd });

		if (checkResult.exitCode === 0) {
			if (config.json) {
				logger.info("format check passed {subsystem}", { subsystem });
			} else {
				process.stdout.write(
					`${c.catGreen("✓")} ${c.overlay0(subsystem)} format check passed\n`,
				);
			}
			continue;
		}

		// Format check failed — try to auto-fix
		const fixAction = sub.autoFix?.[FORMAT_CHECK];
		if (!fixAction || !sub.commands[fixAction]) {
			if (config.json) {
				logger.error("format check failed (no auto-fix) {subsystem}", {
					subsystem,
				});
			} else {
				process.stdout.write(
					`${c.catRed("✗")} ${c.overlay0(subsystem)} format check failed (no auto-fix available)\n`,
				);
			}
			hasFailure = true;
			continue;
		}

		const fixDef = sub.commands[fixAction];
		const { cmd: fixCmd } = resolveCommandDef(fixDef);

		// Check for partial staging conflicts
		const conflictingFiles = files.filter((f) => partiallyStaged.has(f));
		if (conflictingFiles.length > 0) {
			if (config.json) {
				logger.error("partially staged files need formatting {subsystem}", {
					subsystem,
					files: conflictingFiles,
				});
			} else {
				process.stdout.write(
					`${c.catYellow("⚠")} ${c.overlay0(subsystem)} has partially staged files that need formatting:\n`,
				);
				for (const f of conflictingFiles) {
					process.stdout.write(`  ${c.overlay0(f)}\n`);
				}
				process.stdout.write(
					`${c.overlay0("Please stage or stash your changes and run the formatter manually.")}\n`,
				);
			}
			hasFailure = true;
			continue;
		}

		// Run formatter
		run(fixCmd, { cwd });

		// Re-stage formatted files
		for (const file of files) {
			runPiped(["git", "add", file]);
		}

		if (config.json) {
			logger.info("auto-formatted and re-staged {subsystem}", { subsystem });
		} else {
			process.stdout.write(
				`${c.catGreen("✓")} ${c.overlay0(subsystem)} auto-formatted and re-staged\n`,
			);
		}
	}

	return hasFailure ? 1 : 0;
}
