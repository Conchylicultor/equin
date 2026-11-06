import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  DRIZZLE_CONFIG_PATH,
  MIGRATIONS_DATA_DIR,
  MIGRATIONS_PLUGIN_DIR,
  SCHEMA_SNAPSHOT_FILE,
  schemaFilesIn,
} from "@plugins/database/plugins/migrations/core";
import {
  repoSnapshotNow,
  type RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import {
  buildModuleGraph,
  currentRecordStore,
  recordKey,
  type RecordStore,
} from "@plugins/plugin-meta/plugins/plugin-records/core";

/**
 * drizzle-kit's "no schema change" verdict, as a record keyed by exactly what
 * a `generate` run reads (redesign item 5 of the build pipeline track,
 * research/2026-11-04-global-build-pipeline-step5-migrations-verdict-and-cold-records.md):
 *
 *   - the code it loads: every schema-glob file and its import closure (their
 *     module Merkle keys), the drizzle config, and the code that runs and
 *     reads it here (this plugin's `migrations.ts` closure, the load probe);
 *   - which files are schema files (a new `tables.ts` is a new answer);
 *   - the staged out-dir: the tip snapshot and the journal, read AFTER the
 *     reset / join / settle / journal steps that may rewrite them;
 *   - the npm code (drizzle-kit, drizzle-orm): the lockfile, and the runtime
 *     (the store's environment).
 *
 * Only one outcome is ever stored: the probe loaded every file, and either
 * found the schema to be the tip snapshot or drizzle-kit emitted nothing,
 * asked nothing and reported nothing. So a hit can only stand for "nothing to
 * do". Every other outcome probes (and runs drizzle-kit) again.
 *
 * This is the warm path in front of the exact one: a miss costs the probe's
 * comparison (`probeSchema`), not drizzle-kit, unless the schema really
 * changed.
 *
 * What escapes the key, as for every record: a schema module that reads a
 * file or the environment at load (none does — drizzle.config.ts' own rule),
 * or a gitignored schema file (the snapshot holds git's set). Caught, not
 * prevented: `migrations-in-sync` runs drizzle-kit fresh on every push.
 */

// Bump when what a verdict means changes without any keyed code changing.
const VERDICT_VERSION = "drizzle-verdict-1";

// The code that computes the verdict besides the schema itself, repo-relative.
// `migrations.ts` reaches the migrations core (staging, argv, the probe's
// caller); the probe script and the config are loaded by children, not
// imported, so they are named.
const VERDICT_CODE = [
  "plugins/framework/plugins/cli/plugins/migrations/cli/migrations.ts",
  `${MIGRATIONS_PLUGIN_DIR}/${DRIZZLE_CONFIG_PATH}`,
  `${MIGRATIONS_PLUGIN_DIR}/scripts/require-probe.ts`,
];

const VERDICT = "no-change";

export interface DrizzleVerdict {
  /** Was "nothing to generate" already answered for these exact inputs? */
  readonly hit: boolean;
  /** How many schema files the key covers (for the log). */
  readonly schemaFiles: number;
  /** Record that drizzle-kit answered "nothing to generate" for them. */
  record(): void;
}

/**
 * The verdict for the checkout at `root` as it is NOW (`repoSnapshotNow`: the
 * build's view, which every earlier write of the build updated, or a fresh
 * snapshot), so a file the build wrote earlier (a generated module a schema
 * file imports, the journal the bookkeeping just rewrote) is keyed by its
 * current bytes.
 */
export async function drizzleVerdict(
  root: AppPath,
  store: RecordStore = currentRecordStore(),
): Promise<DrizzleVerdict> {
  const snapshot = await repoSnapshotNow(root);
  const key = await drizzleVerdictKey(snapshot, store);
  const hit = store.getMany("verdict", [key.key]).get(key.key) === VERDICT;
  return {
    hit,
    schemaFiles: key.schemaFiles,
    record: () => store.putMany("verdict", [[key.key, VERDICT]]),
  };
}

/** The key alone, over a snapshot the caller holds (tests). */
export async function drizzleVerdictKey(
  snapshot: RepoSnapshot,
  store: RecordStore,
): Promise<{ key: string; schemaFiles: number }> {
  const schema = schemaFilesIn(snapshot);
  if (schema.length === 0)
    throw new Error(
      "[migrations] no schema-glob file in the repo snapshot: the verdict would key an empty schema",
    );
  const graph = await buildModuleGraph(
    { snapshot, store, readOutside: () => null },
    [...schema, ...VERDICT_CODE],
  );
  const blobOr = (rel: string): string =>
    snapshot.has(rel) ? snapshot.blobOf(rel) : "-";
  const meta = `${MIGRATIONS_DATA_DIR}/meta`;
  return {
    key: recordKey(
      VERDICT_VERSION,
      store.environment,
      ...schema.map((f) => `${f}=${graph.keyOf(f)}`),
      ...VERDICT_CODE.map((f) => graph.keyOf(f)),
      blobOr(`${meta}/${SCHEMA_SNAPSHOT_FILE}`),
      blobOr(`${meta}/_journal.json`),
      blobOr("bun.lock"),
    ),
    schemaFiles: schema.length,
  };
}
