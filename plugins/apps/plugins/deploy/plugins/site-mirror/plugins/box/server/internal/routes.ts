import { db } from "@plugins/database/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { hostOnly } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/host-only/server";
import {
  readMirrorChanges,
  readMirrorCopy,
  readMirrorKeys,
  readMirrorRows,
  resolveMirrorSet,
} from "@plugins/database/plugins/table-mirror/plugins/source/server";
import {
  mirrorChangesEndpoint,
  mirrorCopyEndpoint,
  mirrorKeysEndpoint,
  mirrorRowsEndpoint,
} from "@plugins/apps/plugins/deploy/plugins/site-mirror/core";

// Each route: the set named by the question, resolved against this release's
// own registry (the allowlist — an unknown set answers `unknown-set`), then
// the source's reader. Read-only transactions; nothing here writes.

export const handleMirrorChanges = hostOnly(
  implement(mirrorChangesEndpoint, async ({ query: { q } }) => {
    const set = resolveMirrorSet(q.setId);
    if ("kind" in set) return set;
    return readMirrorChanges(db, {
      set,
      cursor: q.cursor,
      maxRows: q.maxRows,
      maxBytes: q.maxBytes,
    });
  }),
);

export const handleMirrorCopy = hostOnly(
  implement(mirrorCopyEndpoint, async ({ query: { q } }) => {
    const set = resolveMirrorSet(q.setId);
    if ("kind" in set) return set;
    return readMirrorCopy(db, {
      set,
      table: q.table,
      afterPk: q.afterPk,
      maxRows: q.maxRows,
      maxBytes: q.maxBytes,
    });
  }),
);

export const handleMirrorKeys = hostOnly(
  implement(mirrorKeysEndpoint, async ({ query: { q } }) => {
    const set = resolveMirrorSet(q.setId);
    if ("kind" in set) return set;
    return readMirrorKeys(db, {
      set,
      table: q.table,
      columns: q.columns,
      afterPk: q.afterPk,
      maxKeys: q.maxKeys,
    });
  }),
);

export const handleMirrorRows = hostOnly(
  implement(mirrorRowsEndpoint, async ({ query: { q } }) => {
    const set = resolveMirrorSet(q.setId);
    if ("kind" in set) return set;
    return readMirrorRows(db, {
      set,
      table: q.table,
      columns: q.columns,
      pks: q.pks,
      maxBytes: q.maxBytes,
    });
  }),
);
