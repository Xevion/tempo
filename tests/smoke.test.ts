import { describe, expect, test } from "bun:test";
import { defineCommand, defineConfig } from "@xevion/tempo";

describe("smoke", () => {
	test("defineConfig returns config object", () => {
		const config = defineConfig({
			subsystems: ["test"],
			check: { commands: [] },
		});
		expect(config).toBeDefined();
		expect(config.subsystems).toEqual(["test"]);
	});

	test("defineCommand returns command entry", () => {
		const cmd = defineCommand({
			run: () => {},
		});
		expect(cmd).toBeDefined();
	});
});
