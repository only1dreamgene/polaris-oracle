# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base

# better-sqlite3 needs a native build toolchain; the Stellar CLI (used only
# by StellarService.deployMarket, a rare admin-only path) needs libdbus —
# without it the CLI segfaults on startup with no useful error, a real trap
# documented in the contracts repo. curl+tar to fetch the CLI binary itself.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ curl ca-certificates tar libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*

ARG STELLAR_CLI_VERSION=27.1.0
RUN ARCH=$(dpkg --print-architecture) && \
    case "$ARCH" in \
      amd64) TARGET=x86_64-unknown-linux-gnu ;; \
      arm64) TARGET=aarch64-unknown-linux-gnu ;; \
      *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/stellar/stellar-cli/releases/download/v${STELLAR_CLI_VERSION}/stellar-cli-${STELLAR_CLI_VERSION}-${TARGET}.tar.gz" \
      -o /tmp/stellar-cli.tar.gz && \
    tar -xzf /tmp/stellar-cli.tar.gz -C /usr/local/bin stellar && \
    rm /tmp/stellar-cli.tar.gz && \
    stellar --version

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# Market deployment reads wasm/*.wasm and initializes with ORACLE_SECRET_KEY
# directly as --source (see stellar.service.ts) — no separate CLI identity
# to provision at container start, unlike an earlier design.

EXPOSE 3000
VOLUME ["/app/data"]

CMD ["node", "dist/src/main"]
