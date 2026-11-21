# Rust toolchain for building and testing the Concordium contracts in a container.
# Used on machines where native Rust builds are blocked (for example Windows Smart App Control).
# Full (not slim) image: cargo-concordium's dependencies compile C++ and need g++.
FROM rust:1.85-bookworm
ENV CARGO_NET_RETRY=10
RUN rustup target add wasm32v1-none \
 && cargo install --locked cargo-concordium@5.0.0 \
 && rm -rf /usr/local/cargo/registry
WORKDIR /work
