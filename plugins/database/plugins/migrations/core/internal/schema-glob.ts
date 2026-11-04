import { SCHEMA_GLOBS } from "./schema-glob-patterns";
import { scanGlob } from "@plugins/packages/plugins/timed-fs/core";
import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";

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
    for await (const match of scanGlob(pattern, { cwd: root }))
      files.add(match);
  }
  return [...files].sort();
}

/**
 * The same set, matched over a file set the caller already holds (the build's
 * repo snapshot) instead of a walk of the disk: the same patterns, matched by
 * the same `Bun.Glob`. A file set from git holds no gitignored file, which is
 * the one difference from {@link schemaGlobFiles} (a gitignored `tables.ts`
 * is not a thing this repo has; a test proves the two agree on the checkout).
 */
export function schemaFilesIn(files: RepoFiles): string[] {
  const globs = SCHEMA_GLOBS.map((p) => new Bun.Glob(p));
  return files.under("plugins").filter((f) => globs.some((g) => g.match(f)));
}
