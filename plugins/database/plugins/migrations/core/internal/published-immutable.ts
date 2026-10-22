/**
 * Published migrations are immutable — the rule, in one spelling.
 *
 * For every published ref R (`publishedMigrationRefs`), every migration file
 * present at `merge-base(HEAD, R)` must exist in the working tree
 * byte-identical. Diffing against the merge-base rather than R itself is what
 * tells "this branch changed a published file" from "this branch is just
 * behind R": a stale branch has every file of its merge-base untouched.
 *
 * Covered: every `.sql` (its sha8 is the runner's ledger key in every deployed
 * DB, and a schema migration's snapshot header — its lineage — is inside those
 * bytes), and every entry of `meta/legacy-snapshots.json` (the lineage of a
 * pre-cutover schema migration): each `<tag>` present at the merge-base must be
 * in the working tree's file with the same `id` / `prevId`.
 * Not covered:
 * - `meta/schema.snapshot.json` — the live tip body, rewritten by every new
 *   schema migration; its id is pinned to the DAG tip by `snapshot-chain-intact`.
 * - `meta/_journal.json` — derived from the `.sql` names and regenerated on
 *   every build, so it legitimately changes whenever a migration is added.
 * - `meta/_*_answers.json` — create-vs-rename history for a migration's
 *   authoring; neither the runner nor drizzle reads a published one, so an
 *   edit changes no database and no chain.
 *
 * Also asserted for every published `.sql`: its filename sha8 is the sha256
 * prefix of its content — the invariant the runner's identity rests on —
 * except the closed set of historical files below that landed before it was
 * enforced and can never be renamed.
 */
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { join } from "path";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import {
  MIGRATIONS_DATA_DIR,
  migrationTreeAt,
  publishedMergeBases,
} from "./published";
import {
  LEGACY_SNAPSHOTS_FILE,
  parseLegacySnapshots,
  readLegacySnapshots,
} from "./schema-snapshot";

const MIGRATION_RE = /^(\d{8})_(\d{6})_([0-9a-f]{8})__(.+)\.sql$/;

/**
 * Published `.sql` files whose filename sha8 is NOT their content hash. They
 * landed before the invariant was enforced and are in every deployed ledger
 * under that sha8, so they can never be renamed. Closed: nothing is ever added.
 */
const LEGACY_HASH_MISMATCHES: ReadonlySet<string> = new Set([
  "20260416_160104_050c75af__tasks_schema_v2.sql",
  "20260416_165556_cb3b7e1d__schema_split_internal.sql",
  "20260417_124452_66316dff__add_task_rank.sql",
  "20260417_150224_26b713bb__add_task_author.sql",
  "20260419_115423_97d022db__rank_collate_c.sql",
  "20260421_123817_4d324a02__add_quick_prompts_table.sql",
  "20260421_142530_06ac885b__use_rank_text_domain.sql",
  "20260424_134225_ba7d51eb__attachments_fk_link_tables.sql",
  "20260430_231110_6596f940__refactor_progress_heuristic.sql",
  "20260503_090000_39283cb0__migrate_category_to_extension.sql",
  "20260510_190957_31be266e__decouple_done_from_gone.sql",
  "20260515_181142_b3cc75fa__dag_schema.sql",
  "20260516_215044_5ae5d7e3__dag_workflow_columns.sql",
  "20260601_130000_b4c0f111__backfill_conversation_model_aliases.sql",
  "20260601_222354_4e6a27df__backfill_avatar_icon_aliases.sql",
]);

/** The sha8 a migration's filename must carry: the sha256 prefix of its bytes. */
export function migrationContentHash(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

/** One published migration file this working tree breaks. */
export type PublishedMigrationViolation =
  | { kind: "missing"; path: string; refs: string[] }
  | { kind: "modified"; path: string; refs: string[] }
  | {
      kind: "legacy-entry";
      /** `meta/legacy-snapshots.json`, repo-relative. */
      path: string;
      tag: string;
      refs: string[];
      /** What the working tree has for `tag` instead: another lineage, or nothing. */
      now: "changed" | "missing";
    }
  | {
      kind: "hash-mismatch";
      path: string;
      refs: string[];
      filenameHash: string;
      contentHash: string;
    };

// Repo-relative path → is it an immutable file (see the docblock).
function isImmutablePath(path: string): boolean {
  const rel = path.slice(MIGRATIONS_DATA_DIR.length + 1);
  return !rel.includes("/") && rel.endsWith(".sql");
}

const LEGACY_PATH = `${MIGRATIONS_DATA_DIR}/meta/${LEGACY_SNAPSHOTS_FILE}`;

// Wedge-breaker for one local `git show`.
const GIT_TIMEOUT_MS = 60_000;

// git's blob id of `bytes`, in the repo's object format (sha1: 40 hex chars,
// sha256: 64) — computed in-process rather than one `git hash-object` per file.
function gitBlobId(bytes: Uint8Array, like: string): string {
  const algo = like.length === 64 ? "sha256" : "sha1";
  return createHash(algo)
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

// The file's bytes, or null when it does not exist (deleted or renamed).
// Any other read error is not an answer about the file and propagates.
async function readIfPresent(abs: string): Promise<Uint8Array | null> {
  try {
    return await readFile(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Every way the working tree at `root` breaks a published migration: a file
 * missing (deleted or renamed), modified, or — for a `.sql` — carrying a
 * filename sha8 that is not its content hash. Empty when the rule holds. Each
 * violation names the published refs whose merge-base with HEAD holds the file.
 */
export async function findPublishedMigrationViolations(
  root: string,
): Promise<PublishedMigrationViolation[]> {
  // path + blob → refs. Keyed on the blob too: two bases disagreeing on a
  // file's content cannot both match the working tree, and each says which.
  const expected = new Map<
    string,
    { path: string; blob: string; refs: Set<string> }
  >();
  // tag → its published lineage (`id prevId`) → refs; a legacy-snapshots.json
  // blob is read once however many bases share it.
  const legacyExpected = new Map<string, Map<string, Set<string>>>();
  const legacyBlobs = new Map<string, string[]>();
  for (const { mergeBase, refs } of await publishedMergeBases(root)) {
    for (const { path, blob } of await migrationTreeAt(root, mergeBase)) {
      if (path === LEGACY_PATH) {
        legacyBlobs.set(blob, [...(legacyBlobs.get(blob) ?? []), ...refs]);
        continue;
      }
      if (!isImmutablePath(path)) continue;
      const key = `${path}\0${blob}`;
      const entry = expected.get(key) ?? { path, blob, refs: new Set() };
      for (const r of refs) entry.refs.add(r);
      expected.set(key, entry);
    }
  }

  // Async reads, one file per turn: the check runner shares one thread across
  // every check, and data/ is tens of MB of snapshots.
  const verdicts = await Promise.all(
    [...expected.values()].map(
      async ({
        path,
        blob,
        refs: refSet,
      }): Promise<PublishedMigrationViolation | null> => {
        const refs = [...refSet];
        const bytes = await readIfPresent(join(root, path));
        if (bytes === null) return { kind: "missing", path, refs };
        if (gitBlobId(bytes, blob) !== blob) {
          return { kind: "modified", path, refs };
        }
        const name = path.slice(path.lastIndexOf("/") + 1);
        const m = MIGRATION_RE.exec(name);
        if (!m || LEGACY_HASH_MISMATCHES.has(name)) return null;
        const contentHash = migrationContentHash(bytes);
        if (contentHash === m[3]) return null;
        return {
          kind: "hash-mismatch",
          path,
          refs,
          filenameHash: m[3]!,
          contentHash,
        };
      },
    ),
  );
  const violations = verdicts.filter(
    (v): v is PublishedMigrationViolation => v !== null,
  );

  for (const [blob, refs] of legacyBlobs) {
    const text = (
      await spawnExpectOk(["git", "cat-file", "blob", blob], {
        cwd: root,
        timeoutMs: GIT_TIMEOUT_MS,
      })
    ).stdout;
    for (const [tag, head] of parseLegacySnapshots(
      text,
      `${LEGACY_PATH}@${blob}`,
    )) {
      const lineage = `${head.id} ${head.prevId}`;
      const byLineage =
        legacyExpected.get(tag) ?? new Map<string, Set<string>>();
      const set = byLineage.get(lineage) ?? new Set<string>();
      for (const r of refs) set.add(r);
      byLineage.set(lineage, set);
      legacyExpected.set(tag, byLineage);
    }
  }
  if (legacyExpected.size > 0) {
    const now = readLegacySnapshots(join(root, MIGRATIONS_DATA_DIR));
    for (const [tag, byLineage] of legacyExpected) {
      const head = now?.get(tag);
      for (const [lineage, refs] of byLineage) {
        if (head !== undefined && `${head.id} ${head.prevId}` === lineage)
          continue;
        violations.push({
          kind: "legacy-entry",
          path: LEGACY_PATH,
          tag,
          refs: [...refs],
          now: head === undefined ? "missing" : "changed",
        });
      }
    }
  }
  const key = (v: PublishedMigrationViolation) =>
    v.kind === "legacy-entry" ? `${v.path}#${v.tag}` : v.path;
  return violations.sort((a, b) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
  );
}

const SHORT_REF = (ref: string) =>
  ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");

/** The one rendering of a violation list, shared by the check and push. */
export function formatPublishedMigrationViolations(
  violations: readonly PublishedMigrationViolation[],
): string {
  return violations
    .map((v) => {
      const on = `(published on ${v.refs.map(SHORT_REF).join(", ")})`;
      switch (v.kind) {
        case "missing":
          return `  missing  ${v.path} ${on}`;
        case "modified":
          return `  modified ${v.path} ${on}`;
        case "hash-mismatch":
          return `  hash     ${v.path} ${on}: filename sha8 ${v.filenameHash}, content sha8 ${v.contentHash}`;
        case "legacy-entry":
          return `  lineage  ${v.path} "${v.tag}" ${v.now === "missing" ? "removed" : "changed"} ${on}`;
      }
    })
    .join("\n");
}

/** The fix, stated once for every surface that reports a violation. */
export const PUBLISHED_MIGRATION_HINT =
  "A migration on any `main` this checkout knows of (local `main` or `<remote>/main`) is published:\n" +
  "deployed databases record its sha8, and its lineage (its .sql's snapshot header, or its\n" +
  "meta/legacy-snapshots.json entry) is a link of the chain. Never edit, delete or rename one.\n" +
  "Restore the listed files from the named ref, e.g.\n" +
  `  git checkout main -- ${MIGRATIONS_DATA_DIR}/<file>\n` +
  "and change the schema with a NEW migration instead (edit schema.ts, then ./singularity build).";
