<#
Builds the bounty_board module (schema embedded) into dist/bounty_board.wasm.v1
using the container toolchain. On a machine with Rust 1.85 and cargo-concordium 5 installed natively:
  cd contracts/bounty-board; cargo concordium build --out ../../dist/bounty_board.wasm.v1
#>
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
New-Item -ItemType Directory -Force (Join-Path $repo "dist") | Out-Null
& (Join-Path $PSScriptRoot "cargo.ps1") contracts/bounty-board concordium build --out /work/dist/bounty_board.wasm.v1
exit $LASTEXITCODE
