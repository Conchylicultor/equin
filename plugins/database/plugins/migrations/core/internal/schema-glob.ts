import { SCHEMA_GLOBS } from "./schema-glob-patterns";

/**
 * Enumerate the schema-glob files drizzle-kit discovers, from the SAME constant
 * drizzle.config.ts builds its `schema:` array out of. Returns sorted repo-relative
 * paths — the form `Bun.Glob` / `git grep` report.
 *
 * This used to read drizzle.config.ts as TEXT and regex the array out, which could
 * silently return a SUBSET (a `schema: [` in prose, a `]` inside a glob character class,
 * a non-literal element) — the checks would then inspect fewer files than drizzle-kit and
 * keep passing. There is no parse any more.
 *
 * Async on purpose: its callers are checks, and every check in a `./equin
 * check` pass shares one thread, so a blocking `Bun.Glob#scanSync` walk here
 * stalls the whole pass (checks/CLAUDE.md's stall watch). `Bun.Glob#scan()` has
 * the same filesystem-glob semantics (gitignored files included, matching what
 * drizzle-kit itself discovers), just non-blocking.
 */
export async function schemaGlobFiles(root: string): Promise<string[]> {
  const files = new Set<string>();
  for (const pattern of SCHEMA_GLOBS) {
    for await (const match of new Bun.Glob(pattern).scan({ cwd: root }))
      files.add(match);
  }
  return [...files].sort();
}
