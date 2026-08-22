import { runMain } from "./cli.ts";
import { registerStandaloneExecutable } from "./register.standalone.ts";

/**
 * Entry point for `bun build --compile`, kept separate from `cli.ts` so the embedded
 * bundle text in `register.standalone.ts` never reaches `dist/cli.mjs`'s build graph.
 *
 * No top-level await: `--bytecode` compiles this entry as CommonJS.
 */
registerStandaloneExecutable().then(runMain);
