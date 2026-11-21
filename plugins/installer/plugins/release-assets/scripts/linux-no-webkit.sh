#!/usr/bin/env bash
# Linux: without webkit2gtk (a bare ubuntu:22.04 container) the probe FAILS —
# the loader refuses the binary — so stage 0 falls back to the terminal.
# Env: ASSET.
set +e
docker run --rm -v "$RUNNER_TEMP/dist:/dist:ro" ubuntu:22.04 "/dist/$ASSET" --probe
code=$?
set -e
echo "probe exit code without webkit2gtk: $code"
[ "$code" != 0 ]
