/**
 * The ONE declaration of which files drizzle-kit discovers as schema.
 *
 * Two independent consumers read this and MUST agree, or the schema-glob checks
 * inspect a different file set than migration generation does — a silent partial DROP:
 *   1. `../drizzle.config.ts` → drizzle-kit's `schema:` array (authoritative)
 *   2. `./schema-glob.ts` → `schemaGlobFiles()`, used by `schema-files-loadable`
 *      and `table-defs-in-schema-glob`.
 * The `database-migrations:drizzle-config-schema-globs` check proves they agree.
 *
 * ZERO IMPORTS is load-bearing: drizzle-kit loads drizzle.config.ts via a synchronous
 * `require()`, so this module must never pull in `fs` / `Bun.Glob` / a plugin barrel.
 * String constants only.
 *
 * Patterns are REPO-ROOT-RELATIVE — the anchor both consumers can name. Neither
 * `process.cwd()` nor this file's own location is the anchor.
 */
export const SCHEMA_GLOBS = [
  "plugins/**/server/**/internal/tables.ts",
  "plugins/**/server/**/internal/tables-*.ts",
  "plugins/**/server/**/internal/schema.ts",
  "plugins/**/server/**/internal/schema-*.ts",
] as const;

/**
 * This plugin's repo-relative dir — drizzle-kit's cwd for every sanctioned
 * invocation. Re-exported from `../index.ts`: three consumers outside this file
 * need it, two of them in other plugins.
 *   1. `./schema-load-probe.ts` — the require-probe's cwd (read by the
 *      `schema-files-loadable` check and by `generateMigration`).
 *   2. `framework/tooling/plugins/checks/plugins/migrations-in-sync` — spawns
 *      `drizzle-kit generate` from here.
 *   3. `framework/cli/plugins/migrations/cli/migrations.ts` — likewise, for the real build.
 *
 * The cwd is LOAD-BEARING, not incidental: drizzle-kit resolves every relative
 * path in `drizzle.config.ts` against it — the `schema:` globs (re-anchored with
 * REPO_ROOT_FROM_MIGRATIONS_DIR) and `out: "./data"`. Run it from the wrong
 * directory and the globs expand to NOTHING, so drizzle-kit exits 0 having
 * discovered no tables and generates no migration — a silent DROP, not an error.
 * That is why this is one constant rather than a literal per call site.
 *
 * This is the repo-relative DEV-TREE source location. It is NOT the runtime
 * migrations dir: the runner reads `EQUIN_MIGRATIONS_DIR ?? <its own
 * dir>/../../data` (`server/internal/runner.ts`), which a released bundle points
 * at `<bundle>/migrations/data`. No runtime path reads this constant.
 */
export const MIGRATIONS_PLUGIN_DIR = "plugins/database/plugins/migrations";

/**
 * Hop from `MIGRATIONS_PLUGIN_DIR` back to the repo root. drizzle-kit resolves a
 * relative `schema` glob against its CWD (not against the config file), so
 * drizzle.config.ts must re-anchor each repo-relative pattern with this prefix. The hop
 * count is NOT eyeballed — the guard check asserts it lands exactly on the repo root.
 */
export const REPO_ROOT_FROM_MIGRATIONS_DIR = "../../../..";
