import type { SubsystemConfig } from "../types.ts";

export interface GoPresetOptions {
	cwd?: string;
	race?: boolean;
	timeout?: string;
	buildTarget?: string;
}

export function go(options?: GoPresetOptions): SubsystemConfig {
	const race = options?.race ?? true;
	const timeout = options?.timeout ?? "5m";
	const buildTarget = options?.buildTarget ?? "./cmd/server";

	const testFlags = race ? "-race -count=1" : "-count=1";

	return {
		aliases: ["go", "golang"],
		commands: {
			"format-check": `bash -c 'test -z "$(goimports -l .)"'`,
			"format-apply": "goimports -w .",
			lint: `golangci-lint run --timeout=${timeout}`,
			build: `go build -o /dev/null ${buildTarget}`,
			test: `go test ${testFlags} ./...`,
		},
		autoFix: {
			"format-check": "format-apply",
		},
	};
}
