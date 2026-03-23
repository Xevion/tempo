# Changelog

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
