#!/usr/bin/env bash
# Linux: the binary probes and runs the real window over a dry run of the
# built checkout's install.sh. Env: ASSET.
#
# Inside a session bus, as on any desktop: without one (xvfb-run starts none)
# WebKitGTK blocks its main thread on D-Bus timeouts for ~30 s, past the
# probe's deadline — stage 0 never tries the window there (install.sh,
# choose_view).
set -euo pipefail
bin="$RUNNER_TEMP/dist/$ASSET"
"$bin" --version
dbus-run-session -- xvfb-run -a "$bin" --probe
# The real window over a dry run: every step's event reaches it.
# It stays open on its done screen, so `timeout` stops it (SIGTERM:
# the window exits with the script's code; xvfb-run then ends).
set +e
EQUIN_INSTALL_DRY_RUN_PACE=0 dbus-run-session -- xvfb-run -a timeout 60 "$bin" --script install.sh -- --dry-run | tee "$RUNNER_TEMP/window.out"
set -e
# The last step's line: every event before it reached the window.
# (A step with sub-steps prints as a bare heading, never a ✓ line.)
grep -qE '✓ Start equin$' "$RUNNER_TEMP/window.out"
