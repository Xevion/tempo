import { describe, expect, test } from "bun:test";
import { defineConfig, Graph, task } from "@xevion/tempo";

describe("smoke", () => {
	test("defineConfig returns the config it was given", () => {
		const config = defineConfig({
			tasks: [task({ name: "check", body: "true", tags: ["check"] })],
			commands: { check: { tags: ["check"] } },
		});
		expect(config.tasks).toHaveLength(1);
		expect(config.commands?.check?.tags).toEqual(["check"]);
	});

	test("task fills in the collection defaults", () => {
		const t = task({ name: "one", body: "true" });
		expect(t.needs).toEqual([]);
		expect(t.tags).toEqual([]);
		expect(t.persistent).toBe(false);
	});

	test("a graph selects by tag", () => {
		const graph = new Graph([
			task({ name: "a", body: "true", tags: ["check"] }),
			task({ name: "b", body: "true" }),
		]);
		expect([...graph.selectByTag("check")]).toEqual(["a"]);
	});
});
