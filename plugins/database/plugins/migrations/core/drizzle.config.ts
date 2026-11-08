import { defineConfig } from "drizzle-kit";
import {
  REPO_ROOT_FROM_MIGRATIONS_DIR,
  SCHEMA_GLOBS,
} from "./internal/schema-glob-patterns";

/**
 * CODEGEN config for `drizzle-kit generate` — and ONLY that subcommand.
 *
 * `generate` is a pure filesystem operation: it diffs the discovered schema
 * files against the snapshots in `./data` and writes SQL. It opens no
 * connection, so this file needs no database. It used to call
 * `readDatabaseConfigSync()` and throw without a worktree identity, which made a
 * filesystem codegen step LOOK database-entangled — the reason migration
 * generation appeared impossible on a host with no local cluster.
 *
 * drizzle-kit's `Config` type still demands credentials, so we hand it an
 * explicit non-connecting sentinel. `.invalid` is the reserved TLD (RFC 2606):
 * it is guaranteed never to resolve, so if a dialing subcommand is ever pointed
 * at this config the connection fails LOUDLY instead of silently reaching a real
 * database — the host's own, or worse, the wrong worktree's.
 *
 * Consequently the dialing subcommands (`push`, `migrate`, `studio`, `pull`) are
 * UNSUPPORTED through this config and must never be wired up: migrations are
 * applied by the runner in `server/internal/runner.ts` on boot, over the
 * backend's own connection.
 *
 * That invariant is enforced twice over, and neither half is a text scan.
 * `internal/drizzle-cli.ts` OWNS the argv — the binary name and `generate`
 * are one literal there, and callers pass typed flags, so no argument shape can
 * express another subcommand. The one remaining way to reach the tool, spelling
 * its name into your own spawn, is caught by the
 * `drizzle-cli-safety/no-adhoc-drizzle-cli` lint rule.
 */
export default defineConfig({
  dialect: "postgresql",
  // Glob discovery: drizzle-kit picks up every plugin's tables.ts / schema.ts
  // directly, not through plugin index.ts files (which would pull in handlers,
  // routes, and other server init code that shouldn't run during codegen).
  //
  // SCHEMA_GLOBS is the single source of truth, shared verbatim with
  // `internal/schema-glob.ts` (the enumerator the schema-glob checks use). The
  // patterns are repo-root-relative; drizzle-kit anchors a relative glob at its CWD
  // — the plugin directory (`MIGRATIONS_PLUGIN_DIR`), not this file's `core/` —
  // hence the prefix. `out` is read against the same CWD. NEVER inline a literal array here: the
  // `database-migrations:drizzle-config-schema-globs` check proves this equals
  // SCHEMA_GLOBS and fails loudly if it doesn't.
  schema: SCHEMA_GLOBS.map((g) => `${REPO_ROOT_FROM_MIGRATIONS_DIR}/${g}`),
  out: "./data",
  dbCredentials: { url: "postgres://codegen@codegen.invalid/codegen" },
});
