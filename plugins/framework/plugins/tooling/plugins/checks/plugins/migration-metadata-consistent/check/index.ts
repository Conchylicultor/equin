import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import {
  MIGRATIONS_DATA_DIR,
  readLegacySnapshots,
  readSnapshotNodes,
} from "@plugins/database/plugins/migrations/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

// ---------------------------------------------------------------------------
// Pure classifier (no fs/git) — exported for unit testing.
//
// The migration store keys three things by the same <tag>:
//   J = journal tags (meta/_journal.json entries[].tag)
//   S = .sql tags    (data/*.sql, minus .sql)
//   L = legacy tags  (meta/legacy-snapshots.json keys: pre-cutover schema
//                     migrations, whose lineage lives there)
// plus the snapshot ids new schema migrations name in their headers.
//
// Invariants asserted:
//   - J === S : every journal entry has a backing .sql, and every .sql has a
//     journal entry. Reported as two diffs:
//       orphanSql     = S \ J  (.sql with no journal entry)
//       orphanJournal = J \ S  (journal entry with no .sql)
//   - L ⊆ S   : every legacy entry maps to a real migration:
//       orphanLegacy  = L \ S
//   - every header id is unique:
//       duplicateHeaderIds = ids two or more .sql headers name
//
// Intentionally NOT asserted: S ⊆ L ∪ headers. Data/backfill migrations
// legitimately carry no lineage (that contract is owned by
// data-migration-dml-only), so a .sql without one must never be flagged.
// ---------------------------------------------------------------------------
export function classifyMigrationMetadata(
  journalTags: Iterable<string>,
  sqlTags: Iterable<string>,
  legacyTags: Iterable<string>,
  headerIds: Iterable<{ tag: string; id: string }>,
): {
  orphanSql: string[];
  orphanJournal: string[];
  orphanLegacy: string[];
  duplicateHeaderIds: { id: string; tags: string[] }[];
} {
  const J = new Set(journalTags);
  const S = new Set(sqlTags);
  const L = new Set(legacyTags);

  const orphanSql = [...S].filter((t) => !J.has(t)).sort();
  const orphanJournal = [...J].filter((t) => !S.has(t)).sort();
  const orphanLegacy = [...L].filter((t) => !S.has(t)).sort();

  const byId = new Map<string, string[]>();
  for (const { tag, id } of headerIds)
    byId.set(id, [...(byId.get(id) ?? []), tag]);
  const duplicateHeaderIds = [...byId]
    .filter(([, tags]) => tags.length > 1)
    .map(([id, tags]) => ({ id, tags: tags.sort() }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { orphanSql, orphanJournal, orphanLegacy, duplicateHeaderIds };
}

const check: Check = {
  id: "migration-metadata-consistent",
  description:
    "journal entries, .sql files, legacy snapshot entries and snapshot headers cross-reference each other",
  async run() {
    const root = await getWorktreeRoot();
    const dir = resolve(root, MIGRATIONS_DATA_DIR);
    const metaDir = join(dir, "meta");

    const journal = JSON.parse(readFileSync(join(metaDir, "_journal.json"), "utf8"));
    const journalTags = (journal.entries as Array<{ tag: string }>).map((e) => e.tag);

    const sqlTags = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.slice(0, -".sql".length));

    const legacyTags = [...(readLegacySnapshots(dir)?.keys() ?? [])];
    const headerIds = (await readSnapshotNodes(dir))
      .filter((n) => n.lineage === "header")
      .map((n) => ({ tag: n.file.slice(0, -".sql".length), id: n.id }));

    const { orphanSql, orphanJournal, orphanLegacy, duplicateHeaderIds } =
      classifyMigrationMetadata(journalTags, sqlTags, legacyTags, headerIds);

    if (
      orphanSql.length === 0 &&
      orphanJournal.length === 0 &&
      orphanLegacy.length === 0 &&
      duplicateHeaderIds.length === 0
    ) {
      return { ok: true };
    }

    const sections: string[] = [];
    if (orphanSql.length > 0) {
      sections.push(
        ".sql files with no journal entry:\n" +
          orphanSql.map((t) => `  ${t}.sql`).join("\n"),
      );
    }
    if (orphanJournal.length > 0) {
      sections.push(
        "journal entries with no .sql file:\n" +
          orphanJournal.map((t) => `  ${t}`).join("\n"),
      );
    }
    if (orphanLegacy.length > 0) {
      sections.push(
        "meta/legacy-snapshots.json entries with no .sql file:\n" +
          orphanLegacy.map((t) => `  ${t}`).join("\n"),
      );
    }
    if (duplicateHeaderIds.length > 0) {
      sections.push(
        "snapshot ids named by more than one migration header:\n" +
          duplicateHeaderIds
            .map(
              (d) => `  ${d.id}: ${d.tags.map((t) => `${t}.sql`).join(", ")}`,
            )
            .join("\n"),
      );
    }

    return {
      ok: false,
      message:
        "migration metadata is inconsistent (journal ↔ .sql ↔ snapshot lineage must cross-reference):\n" +
        sections.join("\n\n"),
      hint:
        "Migration metadata must stay mutually consistent. For an orphan .sql or " +
        "journal entry, run `./singularity build` (or `./singularity normalize-generated`): " +
        "the journal is derived from the .sql filenames and is regenerated unconditionally " +
        "on every run, so a plain build repairs both. Do NOT reach for " +
        "`--reset-migration` — it drops branch-local SCHEMA migrations and does not " +
        "repair an orphan .sql. A legacy entry without its .sql, or two headers naming " +
        "one snapshot, means a published migration was deleted or a header hand-edited: " +
        "restore the files from git (see published-migrations-immutable).",
    };
  },
};

export default check;
