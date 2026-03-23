tempo := "bun run src/cli.ts"

default: check

# Run all checks via tempo
check *args:
    {{ tempo }} check {{ args }}

# Run checks with auto-fix
fix:
    {{ tempo }} check --fix

# Build the CLI binary
build:
    bun run build

# Run tests
test:
    bun test

# Run compatibility tests only
test-compat:
    bun test tests/compat.test.ts

# Audit dependencies for known vulnerabilities
audit:
    bun audit

# Format code
format:
    {{ tempo }} fmt
