#!/usr/bin/env bash
# The repo's packages, without its scripts: the repo's postinstall provisions
# a developer's machine; the release steps need the packages only.
set -euo pipefail
bun install --frozen-lockfile --ignore-scripts
