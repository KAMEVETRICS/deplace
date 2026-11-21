# Rust toolchain for building and testing the Concordium contracts in a container.
# Used on machines where native Rust builds are blocked (for example Windows Smart App Control).
FROM rust:1.85-slim
RUN rustup target add wasm32v1-none \
 && cargo install --locked cargo-concordium@5.0.0 \
 && rm -rf /usr/local/cargo/registry
WORKDIR /work
