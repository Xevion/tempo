default: check

# Type-check, lint, test, and validate package
check:
    bunx tsc --noEmit
    bunx biome check .
    bun test
    npm pack --dry-run
    bunx publint --strict
    bunx @arethetypeswrong/cli --pack .

# Run tests
test:
    bun test

# Run compatibility tests only
test-compat:
    bun test tests/compat.test.ts

# Format code
format:
    bunx biome check --write
