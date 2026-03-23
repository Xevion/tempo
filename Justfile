default: check

# Type-check, lint, build, test, and validate package
check:
    bunx tsc --noEmit
    bunx biome check .
    actionlint
    zizmor .github/
    bun run build
    bun test
    npm pack --dry-run
    bunx publint --strict
    bunx @arethetypeswrong/cli --pack .

# Build the CLI binary
build:
    bun run build

# Run tests
test:
    bun test

# Run compatibility tests only
test-compat:
    bun test tests/compat.test.ts

# Format code
format:
    bunx biome check --write
