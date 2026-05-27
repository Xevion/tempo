# Changelog

## [0.1.4](https://github.com/Xevion/tempo/compare/v0.1.3...v0.1.4) (2026-04-10)


### Features

* auto-reexec under Bun when lockfile or runtime config detected ([11d0d7a](https://github.com/Xevion/tempo/commit/11d0d7a0f7b1d0ad8b552464ecb214b7da37df7d))
* declarative mode-based command specs (parallel/sequential/watch) ([577c89f](https://github.com/Xevion/tempo/commit/577c89fd08552b4f028c20c45fc75f3b4211202b))
* detect interrupted checks, truncate spinner, add Docker helper ([1c901c4](https://github.com/Xevion/tempo/commit/1c901c415e536750081af1afb17bd31d0b36efbd))
* extend spinner to preflights and route TTY output to stderr ([5a57e74](https://github.com/Xevion/tempo/commit/5a57e74c83de0bf9ba23c01418f9a9d22ee2fddd))
* integrate all flags through cleye, promote custom commands to top-level ([bbb2c63](https://github.com/Xevion/tempo/commit/bbb2c6399086fc92bc1f54af589f11f4a597efdc))
* structured JSON output for logs, process output, and check results ([8cd2351](https://github.com/Xevion/tempo/commit/8cd2351c28ea8236eab58c4cc8cffa88610c1ece))
* unified command model — all CLI subcommands defined via config ([0fb76c4](https://github.com/Xevion/tempo/commit/0fb76c4eea3f9636d6a4a136785e01e62197a0e4))


### Bug Fixes

* enforce stdout JSON purity across runners and terminal reset ([43f6697](https://github.com/Xevion/tempo/commit/43f669706a18ba19e392d5c8d90cbc40473f2e9f))
* isCommandGroup misclassifies CommandTree with `run` subcommand; add requireDockerDaemon ([4f379b2](https://github.com/Xevion/tempo/commit/4f379b2a7f0d5bf5cf2c68ff7d816bfdad8a0e46))
* typed errors, fix-on-fail robustness, and stale proc guard ([526f793](https://github.com/Xevion/tempo/commit/526f7935f2de2fd74eafc62bc4298e9a0ee83128))


### Documentation

* revise tempo-config skill to match current API surface ([cd40484](https://github.com/Xevion/tempo/commit/cd40484426dcfff84ff5c6134b977304aee37922))


### Code Refactoring

* decompose check runner, extract registration, fix hook env loss ([21524a3](https://github.com/Xevion/tempo/commit/21524a3f79afa12f8a413bd663ea6e2162009702))
* decompose proc.ts, extract typed errors, clean up API surface ([869547f](https://github.com/Xevion/tempo/commit/869547f3860a67486f7c079c0241c170ba06743c))
* extract shared kill, hook, and tool-check helpers ([530939e](https://github.com/Xevion/tempo/commit/530939eeb02007a295a070a364c3bc19211403c5))
* model tool requirements as typed objects, surface skips ([c50174e](https://github.com/Xevion/tempo/commit/c50174ed6f6006be8d0b9e21b266ea76804f7e02))
* named constants, trim exports, fix lint warnings ([1417a6e](https://github.com/Xevion/tempo/commit/1417a6e448d26dc0c2d4b452a47eea36981a79a6))

## [0.1.3](https://github.com/Xevion/tempo/compare/v0.1.2...v0.1.3) (2026-03-28)


### Bug Fixes

* capture and display build errors when verbose mode is off ([4a64478](https://github.com/Xevion/tempo/commit/4a644786f33a25e7344724e462f82766d9effd2c))
* include BackendWatcher lifetime in ProcessGroup wait methods ([823c42e](https://github.com/Xevion/tempo/commit/823c42e92e6dad4746265081839401292df40187))
* resolve signal handling race that corrupts terminal on Ctrl+C ([881a84f](https://github.com/Xevion/tempo/commit/881a84f3386ca9b8877a20ea3c36ff9a58663e98))


### Documentation

* add tempo-config skill for consumer config authoring ([3d7cb52](https://github.com/Xevion/tempo/commit/3d7cb5265b69a62eff4efba34252588b19c91e7c))


### Code Refactoring

* extract shared hooks, command resolution, and runner logic ([89065cd](https://github.com/Xevion/tempo/commit/89065cd93b8237e8bab9c7de56b3b3e1472a4b01))


### Miscellaneous

* add stricter TypeScript and linting configuration ([2d3755c](https://github.com/Xevion/tempo/commit/2d3755c80e03ea1fadba01993b9b29231efeb496))
* **ci:** bump the github-actions group with 3 updates ([86b6ee1](https://github.com/Xevion/tempo/commit/86b6ee17a5964490fd4402761189d6b905b6e0e8))
* tighten TypeScript and Biome lint rules, fix all warnings ([6a3f48c](https://github.com/Xevion/tempo/commit/6a3f48cd72703727c599b1ac1c0e6dedd665eaa5))

## [0.1.2](https://github.com/Xevion/tempo/compare/v0.1.1...v0.1.2) (2026-03-23)


### Features

* build all library entrypoints to dist/ for Node.js compatibility ([4ca56e4](https://github.com/Xevion/tempo/commit/4ca56e4e054d9e567a8c10a97173c67e5fd08e4b))
* extend self-registration to Node.js via module.register() ([c8a8af4](https://github.com/Xevion/tempo/commit/c8a8af40f9c6e402990c66e0226cefe3f9d9f117))


### Continuous Integration

* add dependency audit step to CI pipeline ([bd6a62a](https://github.com/Xevion/tempo/commit/bd6a62a3be4f76f3e6317e0c4913bbcef29500e6))
* delete redundant fail-if-any-check-failed step ([0319daf](https://github.com/Xevion/tempo/commit/0319daf2b53ba40b8fc7b5391bf3862325023a9a))

## [0.1.1](https://github.com/Xevion/tempo/compare/v0.1.0...v0.1.1) (2026-03-23)


### Features

* add structured logging, Catppuccin theme, and biome toolchain ([c731362](https://github.com/Xevion/tempo/commit/c731362f4e052504e47a203c4484f4a9fa5ecd41))
* add TempoAbortError, structured logging, and config self-registration ([14308ec](https://github.com/Xevion/tempo/commit/14308ecdeaa30829d29d7c0b2ec5e19de4055ff9))
* **dogfood:** run project checks with tempo itself ([99741f9](https://github.com/Xevion/tempo/commit/99741f9ff0504b24e3f8f943467e1a949053d8f9))
* expand custom command entries to support functions and inline specs ([663b09e](https://github.com/Xevion/tempo/commit/663b09ebcf2cb5afd6553f26428f6f255a91ada3))
* initial implementation of @xevion/tempo ([3ee68ff](https://github.com/Xevion/tempo/commit/3ee68ffa262176cfe4a12ce73091557c3bd9d8f1))
* run string commands via sh -c and add sample fixture project ([0d43ca6](https://github.com/Xevion/tempo/commit/0d43ca6ec9ce1d44ff10b7261912dd5ba0f3175c))
* skip commands with missing required tools across all runners ([ba851fd](https://github.com/Xevion/tempo/commit/ba851fdb9a7c60315865185dd13e1085c8146e0e))


### Bug Fixes

* **ci:** use manifest mode for release-please changelog sections ([e6f7cab](https://github.com/Xevion/tempo/commit/e6f7cab05c474a8683c632c5ac95605eeeb07823))


### Documentation

* add MIGRATION.md covering config, runners, hooks, and gotchas ([89513d4](https://github.com/Xevion/tempo/commit/89513d49d9f4b0215cab9c66942a1bf15d914faa))
* add README, LGPL-3.0 license, and publish config ([99de293](https://github.com/Xevion/tempo/commit/99de293afa1e4c302da09b2f6ea0f55416b03698))
* improve README clarity and structure ([a4fcbe8](https://github.com/Xevion/tempo/commit/a4fcbe8e1c7af73471f49f97a84401946c030956))


### Code Refactoring

* replace Bun-specific APIs with Node.js stdlib for cross-runtime compat ([68be852](https://github.com/Xevion/tempo/commit/68be85259d5c17857dfccf6577cdc310fefd2ab0))
* use explicit .ts extensions on all local imports ([f2cff12](https://github.com/Xevion/tempo/commit/f2cff121d64933a3f1922322fff39b18e290453a))


### Continuous Integration

* add GitHub Actions workflow with type check, lint, test, and publish dry run ([9284df8](https://github.com/Xevion/tempo/commit/9284df84f8b6ed3d775f9febc9b10cbf6f8880bb))
* add workflow linting, security hardening, and build step ([7ac944c](https://github.com/Xevion/tempo/commit/7ac944ca900cf42192630dc26d5633dbfa4a46e0))
* set up automated releases and dependency management ([46ead21](https://github.com/Xevion/tempo/commit/46ead21c3b94864c7b71f2421b3387a328a078d6))
