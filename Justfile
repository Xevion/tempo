tempo := "bun run src/cli.ts"

default: check

# Run all checks via tempo
check *args:
    {{ tempo }} check {{ args }}

# Apply every formatter
format:
    {{ tempo }} fmt

# Build the package
build:
    {{ tempo }} build

# Run tests
test:
    bun test

# Run compatibility tests only
test-compat:
    bun test tests/compat.test.ts

# Build the single-file executable into bin/
compile:
    bun run build:compile
