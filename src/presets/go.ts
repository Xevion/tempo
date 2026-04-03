import { FORMAT_APPLY, FORMAT_CHECK, type SubsystemConfig } from "../types.ts";

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
			[FORMAT_CHECK]: `bash -c 'test -z "$(goimports -l .)"'`,
			[FORMAT_APPLY]: "goimports -w .",
			lint: `golangci-lint run --timeout=${timeout}`,
			build: `go build -o /dev/null ${buildTarget}`,
			test: `go test ${testFlags} ./...`,
		},
		autoFix: {
			[FORMAT_CHECK]: FORMAT_APPLY,
		},
	};
}
