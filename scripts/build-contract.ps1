<#
Builds the deplace module (schema embedded) into dist/deplace.wasm.v1
using the container toolchain. On a machine with Rust 1.85 and cargo-concordium 5 installed natively:
  cd contracts/deplace; cargo concordium build --out ../../dist/deplace.wasm.v1
#>
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
New-Item -ItemType Directory -Force (Join-Path $repo "dist") | Out-Null
& (Join-Path $PSScriptRoot "cargo.ps1") contracts/deplace concordium build --out /work/dist/deplace.wasm.v1 --schema-base64-out /work/dist/deplace.schema.b64
exit $LASTEXITCODE
