#!/usr/bin/env bash
# macOS: the window's crate built for both architectures.
#
# Env: EQUIN_INSTALLER_PAGE (the bundled page the crate compiles in).
set -euo pipefail
# shellcheck source=release-config.sh
. "$(dirname "$0")/release-config.sh"
export MACOSX_DEPLOYMENT_TARGET=11.0
for target in aarch64-apple-darwin x86_64-apple-darwin; do
  cargo build --manifest-path "$CRATE/Cargo.toml" --locked --release --target "$target"
done
