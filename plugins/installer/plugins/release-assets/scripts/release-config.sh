# shellcheck shell=bash
# The release workflow's settings (.github/workflows/installer-release.yml),
# sourced by its step scripts beside this file. They live here, not in the
# workflow's YAML, so changing one never edits a file under .github/workflows/
# (which forces every clone's push to need the GitHub `workflow` scope).

# Whether a pushed release tag builds the installer window. Off while the
# install is terminal-only (install.sh DEFAULT_VIEW=terminal): the window's
# builds (a macOS runner, two Linux ones) were the slow part of a release.
# Turn on with DEFAULT_VIEW. A manual run decides with its `window` input.
WINDOW_ON_TAGS=false

# The release tag grammar as a POSIX ERE. Must equal RELEASE_TAG_ERE in
# plugins/upstream/plugins/release/core — the release-assets:tag-grammar
# check holds the two equal.
RELEASE_TAG_ERE='^v([0-9]{4})\.([0-9]{2})\.([0-9]{2})(\.([0-9]+))?$'

# The window's crate, in the checkout being built; a tag without it predates
# the installer window.
CRATE=plugins/installer/plugins/window/rust
