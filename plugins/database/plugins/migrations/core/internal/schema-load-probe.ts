import { resolve } from "path";
import { z } from "zod";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { schemaGlobFiles } from "./schema-glob";
import { MIGRATIONS_PLUGIN_DIR } from "./schema-glob-patterns";

const SchemaLoadFailureSchema = z.object({
  file: z.string(),
  error: z.string(),
});
const SchemaProbeSchema = z.object({
  failures: z.array(SchemaLoadFailureSchema),
  matchesTip: z.boolean().nullable(),
});
/** One schema-glob file drizzle-kit could not load, with the error it threw. */
export type SchemaLoadFailure = z.infer<typeof SchemaLoadFailureSchema>;
/** What one probe answered: the files that failed to load, and (when asked) whether the schema is the tip. */
export type SchemaProbe = z.infer<typeof SchemaProbeSchema>;
/**
 * Every schema-glob file that drizzle-kit's synchronous `require()` cannot
 * load, as `{ file, error }` — empty when all of them load.
 *
 * drizzle-kit swallows a schema file that throws at load and exits 0 having
 * generated a migration WITHOUT that file's tables: a silent drop, whatever the
 * error is. Asking its output which errors it printed only catches the kinds
 * someone listed. So the one question — "does each file load?" — is answered by
 * loading each one, the way drizzle-kit does, before trusting a generation.
 *
 * One subprocess (`scripts/require-probe.ts`) replicates drizzle-kit's load:
 * run from this plugin's dir (its module/tsconfig resolution) with exactly
 * drizzle-kit's environment — which is to say, no runtime namespace. A schema
 * file that resolves one at module eval would break real generation, so the
 * probe must not be handed one the real run does not have.
 *
 * Read by `schema-files-loadable` (every check pass) and by
 * `generateMigration` (before every drizzle-kit run). Throws when the probe
 * itself produces no parseable answer: an unanswered question is not "no
 * failures".
 */
export async function schemaLoadFailures(
  root: string,
): Promise<SchemaLoadFailure[]> {
  return (await probeSchema(root)).failures;
}

/**
 * The same probe, and — given `tip`, the absolute path of the tip snapshot —
 * whether the schema the loaded files declare IS that snapshot: drizzle-kit's
 * own `generateDrizzleJson` over their exports, compared with the tip's body
 * (key order and the two ids aside). `matchesTip: true` means a `generate`
 * has nothing to diff, so `generateMigration` need not run it; it is null
 * when not asked, or when a file failed to load. One child for both answers:
 * loading the 127 files is the probe's whole cost, and drizzle-kit would load
 * them again.
 */
export async function probeSchema(
  root: string,
  opts?: { tip?: string },
): Promise<SchemaProbe> {
  const absFiles = (await schemaGlobFiles(root)).map((f) => resolve(root, f));
  const result = await spawnCaptured(
    [
      process.execPath,
      "--bun",
      resolve(root, MIGRATIONS_PLUGIN_DIR, "scripts/require-probe.ts"),
      ...(opts?.tip === undefined ? [] : ["--tip", opts.tip]),
      ...absFiles,
    ],
    {
      cwd: resolve(root, MIGRATIONS_PLUGIN_DIR),
      env: { ...process.env, NO_COLOR: "1" },
      // The probe require()s every schema-glob file in one pass — seconds of
      // module loading, no I/O that can block indefinitely. Three minutes is
      // there for the case a schema file's module scope does something that
      // never returns, which is exactly the class of bug this hunts.
      timeoutMs: 180_000,
    },
  );
  // A non-zero exit with parseable stdout is fine (per-file errors are in the
  // array); only output that does not parse is the probe itself failing.
  try {
    return SchemaProbeSchema.parse(JSON.parse(result.stdout));
  } catch (parseErr) {
    throw new Error(
      `schema-load probe produced unparseable output (${String(parseErr)}).\n` +
        `exit code: ${result.exitCode}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
    );
  }
}
