import { defineConfig } from "../../src/index";

export default defineConfig({
  subsystems: {
    alpha: {
      aliases: ["a"],
      commands: {
        "format-check": 'echo "alpha format-check ok"',
        "format-apply": 'echo "alpha format-apply ok"',
        lint: 'echo "alpha lint ok"',
        test: 'echo "alpha test ok"',
      },
      autoFix: {
        "format-check": "format-apply",
      },
    },
    beta: {
      aliases: ["b"],
      commands: {
        "format-check": 'echo "beta format-check ok"',
        "format-apply": 'echo "beta format-apply ok"',
        lint: 'echo "beta lint ok"',
        test: 'echo "beta test ok"',
      },
      autoFix: {
        "format-check": "format-apply",
      },
    },
    failing: {
      aliases: ["f"],
      commands: {
        lint: "exit 1",
        test: "echo FAIL on stderr >&2; exit 2",
      },
    },
  },
  custom: {
    greet: "./scripts/greet.ts",
  },
});
