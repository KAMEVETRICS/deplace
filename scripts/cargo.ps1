<#
Runs cargo inside the bounty-rust:1.85 container (see tools/rust.Dockerfile).

Usage:  scripts/cargo.ps1 <crate dir relative to repo root> <cargo args...>
Example: scripts/cargo.ps1 contracts/bounty-board concordium test

Use it where native Rust builds are blocked, for example by Windows Smart App Control.
The cargo registry and target directory live in Docker volumes, so rebuilds are incremental.
#>
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$CrateDir,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$CargoArgs
)
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dir = ($CrateDir -replace '\\', '/').TrimStart('./')
docker run --rm `
  -v "${repo}:/work" `
  -v bounty-cargo-registry:/usr/local/cargo/registry `
  -v bounty-cargo-target:/target `
  -e CARGO_TARGET_DIR=/target `
  -w "/work/$dir" `
  bounty-rust:1.85 cargo @CargoArgs
exit $LASTEXITCODE
