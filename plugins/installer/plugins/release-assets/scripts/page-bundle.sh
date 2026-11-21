#!/usr/bin/env bash
# page: the installer page bundled once, by the BUILT checkout's own bundler
# (the window crate compiles in the page of its own commit).
set -euo pipefail
bun plugins/installer/plugins/window/scripts/bundle-page.ts "$RUNNER_TEMP/page.html"
