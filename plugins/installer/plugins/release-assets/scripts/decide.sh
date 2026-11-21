#!/usr/bin/env bash
# validate's decision: which ref, is it a release, does it build the window,
# does it publish, is it the newest release. Run in the checkout of the ref.
#
# Env: REF (the tag or ref), EVENT (github.event_name), INPUT_PUBLISH and
# INPUT_WINDOW (the dispatch inputs; empty on a push).
# Outputs: ref, commit, build, window, publish, latest.
set -euo pipefail
# shellcheck source=release-config.sh
. "$(dirname "$0")/release-config.sh"

if [ "$EVENT" = push ]; then
  PUBLISH=true
  WANT_WINDOW=$WINDOW_ON_TAGS
else
  PUBLISH=${INPUT_PUBLISH:-false}
  WANT_WINDOW=${INPUT_WINDOW:-false}
fi

release=false
if [[ $REF =~ $RELEASE_TAG_ERE ]]; then release=true; fi
build=true
publish=$PUBLISH
if [ "$release" = false ]; then
  if [ "$EVENT" = push ]; then
    echo "::notice::$REF is not a release tag (v<YYYY.MM.DD>[.N]); nothing to build."
    build=false publish=false
  elif [ "$publish" = true ]; then
    echo "::error::Only a release tag (v<YYYY.MM.DD>[.N]) can be published; $REF is not one. Turn publish off to only build it."
    exit 1
  fi
fi
if [ "$release" = true ] && [ "$(git cat-file -t "refs/tags/$REF" 2>/dev/null)" != tag ]; then
  echo "::error::$REF is not an annotated tag: ./equin version cut writes every release tag annotated, and the Release's notes are its message."
  exit 1
fi
window=false
if [ -f "$CRATE/Cargo.toml" ]; then window=true; fi
if [ "$window" = false ]; then
  echo "::notice::$REF predates the installer window: its Release carries install.sh, release.json and SHA256SUMS only."
elif [ "$WANT_WINDOW" != true ]; then
  echo "::notice::The installer window is off (terminal-only install): $REF's Release carries install.sh, release.json and SHA256SUMS only."
  window=false
fi
newest="$(git tag -l 'v*' | grep -E "$RELEASE_TAG_ERE" | sort -V | tail -n 1)"
latest=false
if [ "$newest" = "$REF" ]; then latest=true; fi
{
  echo "ref=$REF"
  echo "commit=$(git rev-parse HEAD)"
  echo "build=$build"
  echo "window=$window"
  echo "publish=$publish"
  echo "latest=$latest"
} | tee -a "$GITHUB_OUTPUT"
