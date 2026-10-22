#!/bin/sh
# Merge driver for drizzle migration files
# (plugins/database/plugins/migrations/data/*.sql, meta/_journal.json,
# meta/schema.snapshot.json, and the pre-cutover meta/*_snapshot.json).
# args: %O %A %B %P
#
# Take the upstream side (leave %A untouched). Drop a marker so the normalize
# pass (the `post-rewrite` hook, `push`, or `build`) knows to run
# `regen-migrations` (reset branch-local files + re-run drizzle-kit generate
# against the rebased schema). Marker names are owned by MERGE_MARKER_KINDS in
# ../core/internal/merge-markers.ts.
# Without a conflict, the marker isn't dropped and we skip the wasteful regen.
# Resolve the marker dir exactly as regen-generated.sh does — read its comment
# there for why the ambient GIT_* pointers are unset first and why an
# unresolvable git dir is fatal instead of a skipped marker.
GITDIR=$(unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY; git rev-parse --absolute-git-dir 2>/dev/null) ||
  GITDIR=$(git rev-parse --absolute-git-dir 2>/dev/null) || GITDIR=""
if [ -z "$GITDIR" ]; then
  echo "regen-migrations merge driver: cannot resolve this checkout's git dir; refusing to merge without recording the normalize marker." >&2
  exit 1
fi
mkdir -p "$GITDIR/singularity-merge-markers"
touch "$GITDIR/singularity-merge-markers/migrations"
exit 0
