#!/usr/bin/env bash
# attach: INSTALLER-SHA256SUMS over the built binaries in
# $RUNNER_TEMP/installers. Run in the WORKFLOW's own checkout (as publish).
set -euo pipefail
chmod +x "$RUNNER_TEMP/installers"/equin-installer-*
bun plugins/installer/plugins/release-assets/scripts/assemble.ts \
  --mode installer --dir "$RUNNER_TEMP/installers"
