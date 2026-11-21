#!/usr/bin/env bash
# publish: the Release, as a draft with every file, then public.
#
# Env: TAG, LATEST (is it the newest release tag), BUNDLE (the provenance
# records attest-build-provenance wrote over $RUNNER_TEMP/assets), GH_TOKEN.
set -euo pipefail
ASSETS="$RUNNER_TEMP/assets"
cp "$BUNDLE" "$ASSETS/provenance.intoto.jsonl"
if gh release view "$TAG" >/dev/null 2>&1; then
  gh release delete "$TAG" --yes
fi
# A draft is invisible, so `releases/latest` never names a Release
# whose files are still uploading: it turns public with all of them.
gh release create "$TAG" "$ASSETS"/* --draft --verify-tag --notes-from-tag \
  --title "equin ${TAG#v}"
gh release edit "$TAG" --draft=false --latest="$LATEST"
gh release view "$TAG"
