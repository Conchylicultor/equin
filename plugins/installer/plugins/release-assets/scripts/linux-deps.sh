#!/usr/bin/env bash
# Linux: what the window's crate builds and runs against (webkit2gtk-4.1),
# and xvfb for the smoke test.
set -euo pipefail
sudo apt-get update -qq
sudo apt-get install -y -qq libwebkit2gtk-4.1-dev libgtk-3-dev xvfb
