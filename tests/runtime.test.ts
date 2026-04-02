import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectBunProject } from "../src/runtime.ts";

describe("detectBunProject", () => {
	test("returns true when bun.lockb exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "tempo-test-"));
		try {
			writeFileSync(join(dir, "bun.lockb"), "");
			expect(detectBunProject(dir)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	test("returns true when bun.lock exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "tempo-test-"));
		try {
			writeFileSync(join(dir, "bun.lock"), "");
			expect(detectBunProject(dir)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	test("returns false when no lockfile", () => {
		const dir = mkdtempSync(join(tmpdir(), "tempo-test-"));
		try {
			expect(detectBunProject(dir)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	test("walks up to find lockfile in parent", () => {
		const parent = mkdtempSync(join(tmpdir(), "tempo-test-"));
		const child = join(parent, "sub");
		try {
			mkdirSync(child);
			writeFileSync(join(parent, "bun.lock"), "");
			expect(detectBunProject(child)).toBe(true);
		} finally {
			rmSync(parent, { recursive: true });
		}
	});

	test("does not find lockfile in child directories", () => {
		const parent = mkdtempSync(join(tmpdir(), "tempo-test-"));
		const child = join(parent, "sub");
		try {
			mkdirSync(child);
			writeFileSync(join(child, "bun.lock"), "");
			expect(detectBunProject(parent)).toBe(false);
		} finally {
			rmSync(parent, { recursive: true });
		}
	});
});
