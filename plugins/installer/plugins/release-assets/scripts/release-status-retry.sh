#!/usr/bin/env bash
# release-status: the attach dispatched again, once (`retried=true`). The new
# run waits behind this one (the concurrency group), then finds the Release
# and only attaches.
#
# Env: TAG, DEFAULT_BRANCH (the run is dispatched from it), GH_REPO, GH_TOKEN.
set -euo pipefail
gh workflow run installer-release.yml --ref "$DEFAULT_BRANCH" -f ref="$TAG" -f window=true -f retried=true
