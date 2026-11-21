#!/usr/bin/env bash
# macOS: the universal binary runs — natively, and its x86_64 slice under
# Rosetta. Env: ASSET.
set -euo pipefail
"$RUNNER_TEMP/dist/$ASSET" --version
"$RUNNER_TEMP/dist/$ASSET" --probe
arch -x86_64 "$RUNNER_TEMP/dist/$ASSET" --version
