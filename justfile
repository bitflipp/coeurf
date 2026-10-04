# Default DSN for running and testing; override by exporting COEURF_DB_DSN.
export COEURF_DB_DSN := env("COEURF_DB_DSN", "coeurf:coeurf@/coeurf?parseTime=true")

default:
    @just --list

# Run the server with storage (set COEURF_ADDR to change the :8080 default)
run:
    go run .

# Run the server without a database: the editor works, but without storage
run-static:
    COEURF_DB_DSN= go run .

# Build the single self-contained binary ./coeurf
build:
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o coeurf .

# Run all tests
test: test-go test-e2e

# Go tests, including repository tests against the real database
test-go:
    go vet ./...
    go test -count=1 -p 1 ./...

# Browser tests (needs `npm install` once; set CHROMIUM_PATH to use a system browser)
test-e2e:
    npx playwright test

# Create the database and user used by the default DSN (needs MariaDB root access)
db-setup:
    sudo mariadb -e "CREATE DATABASE IF NOT EXISTS coeurf CHARACTER SET utf8mb4; \
      CREATE USER IF NOT EXISTS 'coeurf'@'localhost' IDENTIFIED BY 'coeurf'; \
      GRANT ALL ON coeurf.* TO 'coeurf'@'localhost';"

clean:
    rm -rf coeurf test-results playwright-report
