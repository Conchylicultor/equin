#!/usr/bin/env bash
# tool-version.sh <tool>: writes `<tool>=<version>` to the step's outputs —
# the exact version mise.lock (in the current checkout) records for it.
# Read directly rather than through mise: `mise install` would also run the
# repo's postinstall hooks (machine setup and the doctor), meant for a
# developer's machine, not a build runner.
set -euo pipefail
tool="$1"
version="$(awk -v t="$tool" '$0 == "[[tools." t "]]" { f = 1; next }
  f && $1 == "version" { gsub(/"/, "", $3); print $3; exit }' mise.lock)"
if [ -z "$version" ]; then
  echo "::error::mise.lock records no version for $tool."
  exit 1
fi
echo "$tool=$version" | tee -a "$GITHUB_OUTPUT"
