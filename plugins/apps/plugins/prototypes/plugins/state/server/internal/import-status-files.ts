import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { count, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import type { IdOf } from "@plugins/ids/core";
import { protoIdKind } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { _prototypeState } from "./tables";

// ONE-TIME import of the retired file store: before the state moved into the
// DB, each prototype's Done / pinned record was `<prototypes>/_status/<id>.json`
// (host-global). A DB with no `prototype_state` row yet imports those files
// once — main on its first boot after the move; a fork made after that
// inherits main's rows and skips; a fork made before imports itself. The files
// are never deleted here (other DBs may still need them). To be removed once
// main has imported (a follow-up task).
//
// `deletedAt` joined the files late (deletion became a status field just before
// the move into the DB): a DB that imported before that never re-imports it —
// its rows exist, so the import skips. Accepted: such a DB is a worktree fork
// made in that window, and a deleted prototype then reads live there only.

/** The retired store's dir name inside the prototypes data dir. */
const STATUS_DIR = "_status";

/** One retired record, as the file store wrote it (a field absent = false / not deleted). */
const StatusFileSchema = z
  .object({
    done: z.boolean().optional(),
    pinned: z.boolean().optional(),
    deletedAt: z.string().datetime().nullable().optional(),
  })
  .strict();

/** One retired record, as a `prototype_state` row. */
export interface StatusFileRow {
  id: IdOf<typeof protoIdKind>;
  done: boolean;
  pinned: boolean;
  deletedAt: Date | null;
}

/** Every retired record in `dir`, by prototype id. A malformed file throws, naming it. */
export function readStatusFiles(dir: string): StatusFileRow[] {
  const names = readdirSync(dir, { withFileTypes: true });
  const rows: StatusFileRow[] = [];
  for (const entry of names) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const id = entry.name.slice(0, -".json".length);
    if (!protoIdKind.is(id)) continue;
    const file = join(dir, entry.name);
    const parsed = StatusFileSchema.safeParse(
      JSON.parse(readFileSync(file, "utf8")),
    );
    if (!parsed.success) {
      throw new Error(
        `prototypes.import-status-files: ${file} is not a status record: ${parsed.error.message}`,
      );
    }
    rows.push({
      id,
      done: parsed.data.done ?? false,
      pinned: parsed.data.pinned ?? false,
      deletedAt:
        parsed.data.deletedAt == null ? null : new Date(parsed.data.deletedAt),
    });
  }
  return rows;
}

/**
 * Import every retired record into `prototype_state` when it has no row yet;
 * otherwise nothing. Idempotent and safe to race (the table lock).
 */
export async function importStatusFiles(): Promise<void> {
  const dir = join(prototypesDir.path, STATUS_DIR);
  await db.transaction(async (tx) => {
    // Serializes racing importers: the second waits, then sees the rows.
    await tx.execute(
      sql`LOCK TABLE ${_prototypeState} IN SHARE ROW EXCLUSIVE MODE`,
    );
    const [row] = await tx.select({ n: count() }).from(_prototypeState);
    if ((row?.n ?? 0) > 0) return;
    // A fresh install never had the file store.
    if (!existsSync(dir)) return;
    const rows = readStatusFiles(dir);
    if (rows.length === 0) return;
    await tx.insert(_prototypeState).values(rows).onConflictDoNothing();
  });
}

export const importStatusFilesWarmup = defineWarmup({
  name: "prototypes.import-status-files",
  description:
    "Imports the retired _status/<id>.json Done / pinned / deleted records into prototype_state, once, when the table is empty.",
  scope: "worktree",
  run: importStatusFiles,
});
