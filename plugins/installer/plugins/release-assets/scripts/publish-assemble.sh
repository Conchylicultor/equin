#!/usr/bin/env bash
# publish: the tag's install.sh (read from git), release.json and SHA256SUMS
# into $RUNNER_TEMP/assets. Run in the WORKFLOW's own checkout: a manual
# rebuild of a tag cut before today's assembling code still uses it.
#
# Env: TAG, COMMIT (the tag's commit), WINDOW (validate's window output).
set -euo pipefail
ASSETS="$RUNNER_TEMP/assets"
mkdir -p "$ASSETS"
git show "$COMMIT:install.sh" > "$ASSETS/install.sh"
installers=()
if [ "$WINDOW" = true ]; then installers=(--installers); fi
bun plugins/installer/plugins/release-assets/scripts/assemble.ts \
  --mode core --tag "$TAG" --commit "$COMMIT" --dir "$ASSETS" \
  ${installers[@]+"${installers[@]}"}
