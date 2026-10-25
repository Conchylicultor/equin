import { count, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { songMidi } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/midi/server";
import {
  midiFolderSongCount,
  midiFoldersStatus,
  recheckMidiFolders,
} from "../../shared/status";
import {
  folderStatuses,
  onFolderStatusChange,
  refreshFolderStatuses,
} from "./folder-status";

// The probe's result, pushed by the probe itself whenever it changed (a config
// edit, a reconcile, the user's Check again) — only while a tab reads it.
export const folderStatusServed = serveValue(midiFoldersStatus, {
  source: "external",
  changes: "notified",
  loader: () => folderStatuses(),
  whileSubscribed: (_params, notify) => onFolderStatusChange(() => notify()),
});

// The songs imported from one folder: a path-prefix count over the MIDI
// side-table (a song's `source_path` is under the folder's real path).
export const folderSongCountServed = serveValue(midiFolderSongCount, {
  source: "db",
  reads: {
    tables: [songMidi.table],
    reason:
      "an import, a removal or a re-keyed path anywhere in the MIDI side-table may move a folder's count",
  },
  loader: async ({ dir }) => {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    const [row] = await db
      .select({ n: count() })
      .from(songMidi.table)
      .where(
        sql`left(${songMidi.table.sourcePath}, ${prefix.length}) = ${prefix}`,
      );
    return row?.n ?? 0;
  },
});

export const handleRecheckMidiFolders = implement(recheckMidiFolders, () =>
  refreshFolderStatuses(),
);
