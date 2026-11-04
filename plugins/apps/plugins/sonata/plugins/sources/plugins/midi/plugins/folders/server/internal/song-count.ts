import { count, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { songMidi } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/midi/server";
import { midiFolderSongCount } from "../../shared/status";
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
