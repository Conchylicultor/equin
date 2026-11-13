import type { RepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import {
  DRIZZLE_CONFIG_PATH,
  MIGRATIONS_DATA_DIR,
  MIGRATIONS_PLUGIN_DIR,
  schemaFilesIn,
} from "@plugins/database/plugins/migrations/core";
import {
  closureRecord,
  gitBlobId,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import { readdir, readFile } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "path";
import { runDrizzleGenerate, type DrizzleVerdict } from "./drizzle-generate";

/** The producer that stages and spawns drizzle-kit: code, read from the checkout it runs from. */
export const IN_SYNC_PRODUCER = new URL(
  "./drizzle-generate.ts",
  import.meta.url,
).href;

/**
 * What `drizzle-kit generate` over the committed migrations depends on, as a
 * `closureRecord` spec:
 *
 *   - `code` — the producer that stages and spawns it (its closure holds the
 *     staging, the argv and the verdict's reading of the output), read from
 *     the checkout this process runs from.
 *   - `data` — the set's modules drizzle-kit LOADS: every schema-glob file
 *     (each keyed over its import closure, so an edit to a helper a
 *     `tables.ts` imports moves it) and the drizzle config it `require()`s
 *     (and through it the glob patterns). drizzle-kit and drizzle-orm are npm
 *     code the closures import: the record keys them (`npmCodeKey`).
 *   - `input` — every file of `data/` by blob id: the stage reads the
 *     snapshot DAG (every `.sql` header, `legacy-snapshots.json`), the tip
 *     snapshot and the journal.
 *
 * So a pass after an edit that reaches no schema file's closure and leaves
 * `data/` alone is a lookup (most edits), and the first pass over a new
 * schema runs drizzle-kit once host-wide.
 */
export function inSyncRecordSpec(repo: RepoSnapshot): {
  name: string;
  code: string[];
  data: string[];
  input: { data: [string, string][] };
} {
  const schema = schemaFilesIn(repo);
  if (schema.length === 0)
    throw new Error(
      "migrations-in-sync: no schema-glob file in the file set — the record would key an empty schema",
    );
  return {
    name: "migrations-in-sync:drizzle-generate",
    code: [IN_SYNC_PRODUCER],
    data: [...schema, `${MIGRATIONS_PLUGIN_DIR}/${DRIZZLE_CONFIG_PATH}`],
    input: {
      data: repo
        .under(MIGRATIONS_DATA_DIR)
        .map((p): [string, string] => [p, repo.blobOf(p)]),
    },
  };
}

/** drizzle-kit's verdict for the checkout `repo` holds, read from its record or computed. */
export async function drizzleInSyncVerdict(
  repo: RepoSnapshot,
): Promise<{ ok: true; value: DrizzleVerdict } | { ok: false; error: string }> {
  const spec = inSyncRecordSpec(repo);
  const r = await closureRecord<DrizzleVerdict, string>(
    repo,
    spec,
    async () => {
      const verdict = await runDrizzleGenerate(repo.root);
      // drizzle-kit read the disk, the key names the set's blobs: a `data/`
      // written meanwhile (a build in this checkout generating the very
      // migration) would store this answer under inputs it was not computed
      // from — shared host-wide. Refuse to store it; the next pass asks again.
      const now = await dataOnDisk(repo.root);
      const keyed = spec.input.data.filter(([p]) => /\.(sql|json)$/.test(p));
      if (JSON.stringify(now) !== JSON.stringify(keyed))
        return {
          ok: false,
          error: `${MIGRATIONS_DATA_DIR} changed on disk while drizzle-kit ran (a concurrent build?) — run the check again`,
        };
      return verdict;
    },
  );
  return r.ok ? { ok: true, value: r.value } : r;
}

/**
 * Every migration file under `data/` on disk now (`.sql`, `.json` — what the
 * stage and a generate read and write; a stray `.DS_Store` is neither), with
 * its blob id, sorted like the set's `under`.
 */
async function dataOnDisk(root: string): Promise<[string, string][]> {
  const out: [string, string][] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(child);
      else if (e.isFile() && /\.(sql|json)$/.test(e.name))
        out.push([child, gitBlobId(await readFile(join(root, child), "utf8"))]);
    }
  };
  await walk(MIGRATIONS_DATA_DIR);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
