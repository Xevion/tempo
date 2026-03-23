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

# Format code
format:
    bunx biome check --write
