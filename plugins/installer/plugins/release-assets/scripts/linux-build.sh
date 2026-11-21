#!/usr/bin/env bash
# Linux: the window's crate, copied to $RUNNER_TEMP/dist/$ASSET.
#
# Env: ASSET, EQUIN_INSTALLER_PAGE (the bundled page the crate compiles in).
set -euo pipefail
# shellcheck source=release-config.sh
. "$(dirname "$0")/release-config.sh"
cargo build --manifest-path "$CRATE/Cargo.toml" --locked --release
mkdir -p "$RUNNER_TEMP/dist"
cp "$CRATE/target/release/equin-installer" "$RUNNER_TEMP/dist/$ASSET"
