# shellcheck shell=sh
# Sourced by ./equin before it execs the CLI: decide the home data root's
# layout from the disk and export it as EQUIN_DATA_ROOT_LAYOUT, so every
# process the CLI starts — a Bun child with no explicit env included, which
# gets its parent's STARTING environment — inherits a decided root instead of
# reading the disk on its own (infra/paths CLAUDE.md, § The data root).
#
# The shell twin of paths/core decideDataRootLayout (data-root-layout.ts), case
# for case, held to it by declare-data-root-sh.test.ts; the tokens are
# HOME_LAYOUT_TOKENS. Two roots (a split) is left undeclared: the CLI's own
# decision throws DataRootSplitError, which names what to do.
#
# Conditionals only: ./equin runs under `set -e`, and nothing here may abort it.
unset EQUIN_DATA_ROOT_LAYOUT
if [ -z "${EQUIN_DIR:-}" ]; then
  _equin_current="$HOME/.equin"
  _equin_legacy="$HOME/.singularity"
  if ! [ -e "$_equin_legacy" ] && ! [ -L "$_equin_legacy" ]; then
    EQUIN_DATA_ROOT_LAYOUT=current
  elif [ -L "$_equin_legacy" ] && [ "$_equin_legacy" -ef "$_equin_current" ]; then
    EQUIN_DATA_ROOT_LAYOUT=current-legacy-link
  elif ! [ -e "$_equin_current" ] && ! [ -L "$_equin_current" ]; then
    EQUIN_DATA_ROOT_LAYOUT=legacy
  fi
  unset _equin_current _equin_legacy
fi
if [ -n "${EQUIN_DATA_ROOT_LAYOUT:-}" ]; then
  export EQUIN_DATA_ROOT_LAYOUT
fi
