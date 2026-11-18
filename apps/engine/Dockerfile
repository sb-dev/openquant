# The engine-batch image: the batch host of OQ-05 sections 4 to 6, deployed to the Fly app of
# infra/fly/openquant-staging-engine-batch.toml. Build it from the repository root:
#
#   docker build --file apps/engine/Dockerfile --tag openquant-engine-batch .
#
# The build fetches only the crates locked in Cargo.lock. The base images are pinned by digest; their tags name the
# pinned Rust toolchain (rust-toolchain.toml) and the Debian release. rust-toolchain.toml is not copied, so rustup uses
# the toolchain of the image and installs nothing. scripts/infrastructure.ts checks the pins, the release build and
# the non-root user. The image holds no credential: Fly app secrets supply them at run time (infra/environments).

FROM rust:1.97.0-slim-bookworm@sha256:6d220bf85c74e842a79da63997af8d2e74455c0b8847d8bb3a5888572334991d AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY packages/api-contracts/schemas packages/api-contracts/schemas
COPY packages/api-contracts/rust packages/api-contracts/rust
COPY packages/quant-core packages/quant-core
COPY apps/engine apps/engine
# A release build: it has no debug assertions, so it refuses the test-only loopback mode (OQ-05 section 5).
RUN cargo build --release --locked -p openquant-engine --bin engine-batch
# Prove it on the built binary: with a complete synthetic configuration it reads (exit 0); with the loopback
# variables added, even in DEVELOPMENT, it refuses to start (exit 2) and names the variable.
RUN set -eu; \
    check() { env -i OPENQUANT_ENVIRONMENT=DEVELOPMENT OPENQUANT_API_URL=https://api.build-check.invalid \
      OPENQUANT_API_TOKEN=build-check-api-token-0000 OPENQUANT_QUEUE_ACCOUNT_ID=buildcheck \
      OPENQUANT_QUEUE_ID=buildcheck OPENQUANT_QUEUE_TOKEN=build-check-queue-token-0000 "$@" \
      /src/target/release/engine-batch --check-config; }; \
    check; \
    status=0; out=$(check OPENQUANT_TEST_LOOPBACK_PORT=8443 OPENQUANT_TEST_LOOPBACK_ROOT=/tmp/root.der 2>&1) || status=$?; \
    test "$status" -eq 2; \
    echo "$out" | grep -q OPENQUANT_TEST_LOOPBACK

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN groupadd --system --gid 10001 openquant \
 && useradd --system --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin openquant
COPY --from=build /src/target/release/engine-batch /usr/local/bin/engine-batch
# The TLS roots are bundled in the binary (webpki roots): no CA package is needed.
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/engine-batch"]
