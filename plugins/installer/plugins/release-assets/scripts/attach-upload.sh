#!/usr/bin/env bash
# attach: the binaries, their provenance, then INSTALLER-SHA256SUMS, uploaded
# to the existing Release.
#
# Env: TAG, BUNDLE (the provenance records attest-build-provenance wrote over
# the binaries), GH_TOKEN.
set -euo pipefail
DIR="$RUNNER_TEMP/installers"
cp "$BUNDLE" "$RUNNER_TEMP/installer-provenance.intoto.jsonl"
# INSTALLER-SHA256SUMS last: stage 0 reads its presence as "every
# binary it lists is uploaded". A re-run first removes it, so no
# client pairs the old sums with a new binary mid-upload.
if gh release view "$TAG" --json assets --jq '.assets[].name' | grep -qx INSTALLER-SHA256SUMS; then
  gh release delete-asset "$TAG" INSTALLER-SHA256SUMS --yes
fi
gh release upload "$TAG" --clobber "$DIR"/equin-installer-*
gh release upload "$TAG" --clobber "$RUNNER_TEMP/installer-provenance.intoto.jsonl"
gh release upload "$TAG" --clobber "$DIR/INSTALLER-SHA256SUMS"
gh release view "$TAG"
