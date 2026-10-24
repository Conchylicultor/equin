import { resolve } from "path";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  MIGRATIONS_PLUGIN_DIR,
  REPO_ROOT_FROM_MIGRATIONS_DIR,
  SCHEMA_GLOBS,
} from "../core/internal/schema-glob-patterns";

// Inlined minimal Check shape (mirrors the sibling orphaned-tables /
// schema-files-loadable checks) to avoid a cross-plugin import of the framework
// Check type from a check file.
type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = {
  id: string;
  description: string;
  alwaysRun?: boolean;
  run(): Promise<CheckResult>;
  cacheSignature?(): string | null;
};

/**
 * PURE helper (exported for unit testing): set-diff two glob sets, already
 * resolved to absolute paths so the two anchors (drizzle-kit's cwd vs the repo
 * root) are normalised away.
 *
 * `missing` = declared in SCHEMA_GLOBS but NOT handed to drizzle-kit — the silent
 * partial-DROP direction: the schema-glob checks inspect files migration
 * generation never sees, so a table vanishing from generation stays green.
 * `extra` = handed to drizzle-kit but absent from SCHEMA_GLOBS — the inverse:
 * drizzle-kit generates for files the checks never inspect.
 */
export function diffGlobSets(
  configGlobs: string[],
  expectedGlobs: string[],
): { missing: string[]; extra: string[] } {
  const config = new Set(configGlobs);
  const expected = new Set(expectedGlobs);
  return {
    missing: [...expected].filter((g) => !config.has(g)).sort(),
    extra: [...config].filter((g) => !expected.has(g)).sort(),
  };
}

const HINT =
  "`plugins/database/plugins/migrations/core/internal/schema-glob-patterns.ts` is the ONE " +
  "declaration of the schema glob set. drizzle.config.ts must build its `schema:` array " +
  "from SCHEMA_GLOBS (re-anchored with REPO_ROOT_FROM_MIGRATIONS_DIR, since drizzle-kit " +
  "resolves a relative glob against its CWD — the migrations plugin dir). Never inline a " +
  "literal array there: a divergence makes the schema-glob checks inspect a DIFFERENT file " +
  "set than migration generation does, so a table can silently vanish from generation " +
  "(spurious DROP) while every check stays green.";

const check: Check = {
  id: "database-migrations:drizzle-config-schema-globs",
  description:
    "drizzle.config.ts's evaluated `schema:` globs equal SCHEMA_GLOBS — the single source of truth the schema-glob checks enumerate from",
  // Cheap structural invariant (one dynamic import, no I/O): guard even
  // `./equin build --skip-checks`.
  alwaysRun: true,
  // Never cache: a stale PASS on a correctness gate is worse than re-running a
  // check this cheap.
  cacheSignature: () => null,
  async run() {
    const root = await getWorktreeRoot();
    const migrationsDir = resolve(root, MIGRATIONS_PLUGIN_DIR);

    // 1. STRUCTURAL — the hop back to the repo root must land exactly on it. A
    //    wrong hop count silently narrows drizzle-kit's discovery to a non-empty
    //    SUBSET (e.g. one `..` short → only the database sub-plugins), which is
    //    precisely the silent partial-DROP failure.
    const landsOn = resolve(migrationsDir, REPO_ROOT_FROM_MIGRATIONS_DIR);
    if (landsOn !== resolve(root)) {
      return {
        ok: false,
        message:
          `REPO_ROOT_FROM_MIGRATIONS_DIR ("${REPO_ROOT_FROM_MIGRATIONS_DIR}") does not land on the repo root:\n` +
          `  from: ${migrationsDir}\n  lands on: ${landsOn}\n  expected: ${resolve(root)}`,
        hint: HINT,
      };
    }

    // 2. VALUE — compare against what drizzle-kit actually evaluates. The
    //    dynamic import keeps `drizzle-kit` out of this check's module-load
    //    graph. Note this compares PATTERNS, not expanded file sets; only
    //    running drizzle-kit proves the expansion, which `migrations-in-sync`
    //    already does.
    const config = (await import("../core/drizzle.config")).default;
    const schema: unknown = config.schema;
    if (!Array.isArray(schema) || schema.some((g) => typeof g !== "string")) {
      return {
        ok: false,
        message:
          `drizzle.config.ts's \`schema\` is not an array of strings (got ${JSON.stringify(schema)}). ` +
          "It cannot be compared against SCHEMA_GLOBS, so the agreement between drizzle-kit and " +
          "schemaGlobFiles() is UNPROVEN — which is a failure, not a pass.",
        hint: HINT,
      };
    }

    const { missing, extra } = diffGlobSets(
      (schema as string[]).map((g) => resolve(migrationsDir, g)),
      SCHEMA_GLOBS.map((g) => resolve(root, g)),
    );
    if (missing.length === 0 && extra.length === 0) return { ok: true };

    const lines: string[] = [];
    if (missing.length > 0) {
      lines.push(
        "  in SCHEMA_GLOBS but NOT in drizzle.config.ts's `schema:` (migration generation " +
          "would MISS these — silent DROP):",
        ...missing.map((g) => `    - ${g}`),
      );
    }
    if (extra.length > 0) {
      lines.push(
        "  in drizzle.config.ts's `schema:` but NOT in SCHEMA_GLOBS (the schema-glob checks " +
          "would never inspect these):",
        ...extra.map((g) => `    - ${g}`),
      );
    }
    return {
      ok: false,
      message: `drizzle.config.ts's \`schema:\` globs diverge from SCHEMA_GLOBS:\n${lines.join("\n")}`,
      hint: HINT,
    };
  },
};

export default check;
