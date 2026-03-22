import { defineCommand } from "../../../src/index";

export default defineCommand({
  name: "greet",
  description: "Print a greeting",
  flags: {
    loud: {
      type: Boolean,
      alias: "l",
      description: "Shout the greeting",
    },
    name: {
      type: String,
      default: "world",
      description: "Who to greet",
    },
  },
  run({ flags }) {
    const msg = `Hello, ${flags.name}!`;
    console.log(flags.loud ? msg.toUpperCase() : msg);
    return 0;
  },
});
