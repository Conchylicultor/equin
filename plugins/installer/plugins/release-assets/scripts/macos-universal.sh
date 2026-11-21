#!/usr/bin/env bash
# macOS: one universal binary, ad-hoc signed, at $RUNNER_TEMP/dist/$ASSET.
#
# lipo drops the linker's per-architecture ad-hoc signatures, and arm64 macOS
# refuses to run unsigned code: sign the result. Ad-hoc is enough for curl
# delivery (a curl download is never quarantined, so Gatekeeper never
# assesses it).
#
# Env: ASSET (the binary's name).
set -euo pipefail
# shellcheck source=release-config.sh
. "$(dirname "$0")/release-config.sh"
out="$RUNNER_TEMP/dist/$ASSET"
mkdir -p "$(dirname "$out")"
lipo -create -output "$out" \
  "$CRATE/target/aarch64-apple-darwin/release/equin-installer" \
  "$CRATE/target/x86_64-apple-darwin/release/equin-installer"
codesign --force --sign - "$out"
codesign --verify --verbose "$out"
archs="$(lipo -archs "$out")"
echo "architectures: $archs"
case " $archs " in *" x86_64 "*) ;; *) exit 1 ;; esac
case " $archs " in *" arm64 "*) ;; *) exit 1 ;; esac
