default: check

# Type-check and lint
check:
    bunx tsc --noEmit
    bunx biome check src/

# Run tests
test:
    bun test

# Format code
format:
    bunx biome check --write src/
