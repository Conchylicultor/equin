#!/usr/bin/env bash
# publish: does the tag's Release exist, and is it (re)created?
#
# Env: TAG, REPLACE (the dispatch input; empty on a push), GH_TOKEN.
# Output: create (true: publish the Release from scratch).
set -euo pipefail
create=true
# Only "release not found" means none: any other error stops here,
# never mistaken for a missing Release (which would republish it).
if ! draft="$(gh release view "$TAG" --json isDraft --jq .isDraft 2>"$RUNNER_TEMP/view.err")"; then
  grep -qx 'release not found' "$RUNNER_TEMP/view.err" || { cat "$RUNNER_TEMP/view.err" >&2; exit 1; }
  draft=none
fi
if [ "$draft" = true ]; then
  echo "::notice::$TAG has only a draft Release (an earlier publish stopped midway): publishing it from scratch."
elif [ "$draft" = false ]; then
  if [ "${REPLACE:-false}" = true ]; then
    echo "::notice::$TAG already has a Release: replacing it (replace is on)."
  else
    echo "::notice::$TAG already has a Release: its files are left as they are (turn replace on to republish it); only the installer is attached."
    create=false
  fi
fi
echo "create=$create" | tee -a "$GITHUB_OUTPUT"
