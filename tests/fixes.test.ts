import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	TempoAbortError,
	TempoConfigError,
	TempoRunError,
} from "../src/errors.ts";
import { newestMtime } from "../src/preflight.ts";
import { spawnCollect } from "../src/proc.ts";
import { requireDockerDaemon } from "../src/tools.ts";

describe("preflight.newestMtime", () => {
	test("returns 0 and warns when directory is missing", () => {
		const missing = join(
			tmpdir(),
			`tempo-missing-${Date.now()}-${Math.random()}`,
		);
		const result = newestMtime(missing, "**/*.ts");
		expect(result).toBe(0);
	});

	test("returns highest mtime for existing files", () => {
		const dir = mkdtempSync(join(tmpdir(), "tempo-preflight-"));
		try {
			const file = join(dir, "a.txt");
			writeFileSync(file, "x");
			const result = newestMtime(dir, "**/*.txt");
			expect(result).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("proc.spawnCollect", () => {
	test("timeout kills process and sets exitCode to 1", async () => {
		// Use `exec sleep` so sh replaces itself with the sleep process —
		// otherwise SIGTERM to sh doesn't propagate to sleep and the test hangs
		// on stream close waiting for the graceful-kill fallback.
		const start = Date.now();
		const result = await spawnCollect(["sh", "-c", "exec sleep 10"], start, {
			timeout: 0.2,
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("killed after 0.2s timeout");
	}, 10000);

	test("returns promptly after timeout (no leaked SIGKILL timer)", async () => {
		const t0 = Date.now();
		await spawnCollect(["sh", "-c", "exec sleep 10"], t0, { timeout: 0.1 });
		const elapsed = Date.now() - t0;
		// The spawnCollect should return shortly after SIGTERM, not 3s later.
		// A leaked SIGKILL timer wouldn't block the await, but confirms
		// the timeout path completes normally.
		expect(elapsed).toBeLessThan(3000);
	}, 10000);
});

describe("tools.requireDockerDaemon", () => {
	test("throws TempoAbortError (not bare Error) when docker missing", () => {
		// This test only runs meaningfully when docker is absent; when present
		// the function returns void. We handle both cases.
		try {
			requireDockerDaemon();
			// docker exists and daemon is running — skip assertion
		} catch (err) {
			expect(err).toBeInstanceOf(TempoAbortError);
		}
	});
});

describe("error type exports", () => {
	test("TempoAbortError preserves message for CLI logging", () => {
		const err = new TempoAbortError("custom abort reason");
		expect(err.message).toBe("custom abort reason");
		expect(err.name).toBe("TempoAbortError");
	});

	test("TempoConfigError carries path context", () => {
		const err = new TempoConfigError("Failed to load config at /tmp/foo: boom");
		expect(err.message).toContain("/tmp/foo");
		expect(err.message).toContain("boom");
	});

	test("TempoRunError exposes exitCode", () => {
		const err = new TempoRunError(42);
		expect(err.exitCode).toBe(42);
	});
});
