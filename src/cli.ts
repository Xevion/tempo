#!/usr/bin/env bun
import { cli, command } from "cleye";
import { loadConfig } from "./config";
import { parseFlagsFromArgv } from "./flags";
import { runCheck } from "./runners/check";
import { runDev } from "./runners/dev";
import { runFmt } from "./runners/fmt";
import { runLint } from "./runners/lint";
import { runPreCommit } from "./runners/pre-commit";
import { runCustom } from "./runners/run";
import type { CommandFlagDef, DevFlag } from "./types";
import pkg from "../package.json";

const checkCommand = command(
  {
    name: "check",
    parameters: ["[targets...]"],
    flags: {
      fix: {
        type: Boolean,
        description: "Auto-fix failed checks",
      },
      config: {
        type: String,
        description: "Override config file path",
        placeholder: "<path>",
      },
    },
    help: { description: "Parallel check orchestrator with auto-fix" },
  },
  async (argv) => {
    const config = await loadConfig({ configPath: argv.flags.config });
    const exitCode = await runCheck(config, argv._.targets ?? [], {
      fix: argv.flags.fix,
    });
    process.exit(exitCode);
  },
);

/** Convert DevFlag spec to CommandFlagDef for parseFlagsFromArgv */
function devFlagToCommandFlag(flag: DevFlag): CommandFlagDef {
  return {
    type: flag.type,
    alias: flag.alias,
    description: flag.description,
    default: flag.default,
  };
}

const devCommand = command(
  {
    name: "dev",
    parameters: ["[targets...]", "--", "[passthrough...]"],
    flags: {
      config: {
        type: String,
        description: "Override config file path",
        placeholder: "<path>",
      },
    },
    help: { description: "Multi-process dev server manager" },
  },
  async (argv) => {
    const config = await loadConfig({ configPath: argv.flags.config });
    const passthrough = argv._.passthrough ?? [];

    // Two-pass flag parsing: cleye handled --config and targets,
    // now parse dev-specific flags from config.dev.flags against raw argv
    let devFlags: Record<string, unknown> = {};
    if (config.dev?.flags && Object.keys(config.dev.flags).length > 0) {
      const flagSpec: Record<string, CommandFlagDef> = {};
      for (const [name, def] of Object.entries(config.dev.flags)) {
        flagSpec[name] = devFlagToCommandFlag(def);
      }
      // Extract the args after "dev" subcommand from process.argv
      const devArgIndex = process.argv.indexOf("dev");
      if (devArgIndex !== -1) {
        const rawDevArgs = process.argv.slice(devArgIndex + 1);
        // Filter out --config and its value, stop at -- passthrough separator
        const filtered: string[] = [];
        for (let i = 0; i < rawDevArgs.length; i++) {
          if (rawDevArgs[i] === "--") break;
          if (rawDevArgs[i] === "--config") {
            i++; // skip value
            continue;
          }
          filtered.push(rawDevArgs[i]);
        }
        const parsed = parseFlagsFromArgv(flagSpec, filtered);
        devFlags = parsed.flags;
      }
    }

    const mergedFlags = { ...argv.flags, ...devFlags };
    const exitCode = await runDev(
      config,
      argv._.targets ?? [],
      mergedFlags,
      passthrough,
    );
    process.exit(exitCode);
  },
);

const fmtCommand = command(
  {
    name: "fmt",
    alias: "format",
    parameters: ["[targets...]", "--", "[passthrough...]"],
    flags: {
      config: {
        type: String,
        description: "Override config file path",
        placeholder: "<path>",
      },
    },
    help: { description: "Sequential per-subsystem formatting" },
  },
  async (argv) => {
    const config = await loadConfig({ configPath: argv.flags.config });
    const passthrough = argv._.passthrough ?? [];
    const exitCode = await runFmt(
      config,
      argv._.targets ?? [],
      passthrough,
    );
    process.exit(exitCode);
  },
);

const lintCommand = command(
  {
    name: "lint",
    parameters: ["[targets...]", "--", "[passthrough...]"],
    flags: {
      config: {
        type: String,
        description: "Override config file path",
        placeholder: "<path>",
      },
    },
    help: { description: "Sequential per-subsystem linting" },
  },
  async (argv) => {
    const config = await loadConfig({ configPath: argv.flags.config });
    const passthrough = argv._.passthrough ?? [];
    const exitCode = await runLint(
      config,
      argv._.targets ?? [],
      passthrough,
    );
    process.exit(exitCode);
  },
);

const preCommitCommand = command(
  {
    name: "pre-commit",
    flags: {
      config: {
        type: String,
        description: "Override config file path",
        placeholder: "<path>",
      },
    },
    help: { description: "Staged-file auto-formatter with partial staging detection" },
  },
  async (argv) => {
    const config = await loadConfig({ configPath: argv.flags.config });
    const exitCode = await runPreCommit(config);
    process.exit(exitCode);
  },
);

const runCommand = command(
  {
    name: "run",
    parameters: ["[name]", "[args...]"],
    flags: {
      config: {
        type: String,
        description: "Override config file path",
        placeholder: "<path>",
      },
      list: {
        type: Boolean,
        alias: "l",
        description: "List all registered custom commands",
      },
    },
    help: { description: "Execute a custom command registered via defineCommand" },
  },
  async (argv) => {
    const config = await loadConfig({ configPath: argv.flags.config });

    if (argv.flags.list) {
      const exitCode = await runCustom(config, "--list", []);
      process.exit(exitCode);
    }

    const name = argv._.name;
    if (!name) {
      console.error("Usage: tempo run <name> [args...]");
      process.exit(1);
    }

    const exitCode = await runCustom(config, name, argv._.args ?? []);
    process.exit(exitCode);
  },
);

await cli(
  {
    name: "tempo",
    version: pkg.version,
    commands: [
      checkCommand,
      devCommand,
      fmtCommand,
      lintCommand,
      preCommitCommand,
      runCommand,
    ],
    help: { description: "Developer script orchestrator" },
  },
);
