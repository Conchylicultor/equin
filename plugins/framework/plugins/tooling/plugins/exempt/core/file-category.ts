/**
 * File categories: the closed vocabulary a rule owner SCOPES its rule by.
 *
 * "This rule does not apply to tests" is a property of the rule, not a list of
 * the files it skips, so an owner declares it as a category (`outOfScope` on a
 * lint barrel or a check) and never names a consumer. A category is a set of
 * repo-relative paths, defined here once as globs — ESLint consumes the globs
 * as `files` patterns, a check consumes the compiled predicate, so the two can
 * never disagree about which file is a test.
 */

export const FILE_CATEGORIES = [
  "test",
  "e2e",
  "script",
  "bin",
  "cli",
  "central",
  "provision",
  "research",
  "generated",
] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];

/**
 * Each category's members, as repo-relative globs (`**`, `*`, `{a,b}` only).
 * The plugin folder ones are matched at any depth: a folder name means the
 * same thing wherever it sits (`plugin-id`'s folder vocabulary).
 *
 * `test` is exactly `isTestCodePath` (`plugin-id/core`) plus the repo-wide
 * vitest harness under `test/` — the unit suite holds the two to each other.
 */
export const FILE_CATEGORY_GLOBS: Readonly<
  Record<FileCategory, readonly string[]>
> = {
  test: ["**/__tests__/**", "**/testing/**", "**/*.test.{ts,tsx}", "test/**"],
  e2e: ["**/e2e/**"],
  script: ["**/scripts/**"],
  bin: ["**/bin/**"],
  cli: ["**/cli/**"],
  central: ["**/central/**"],
  provision: ["**/provision/**"],
  research: ["research/**"],
  // Written by `./equin build` / `bun install` from sources that stay in
  // scope, so a rule over content is enforced at the source, once.
  generated: [
    "**/*.generated.ts",
    "bun.lock",
    "config/**/*.origin.jsonc",
    "docs/plugins-*.md",
  ],
};

/**
 * Files that are NOT app code: test suites and e2e drivers — the categories a
 * contributed lint rule is out of scope in by default.
 *
 * Plugin-contributed lint rules are overwhelmingly *architecture* rules — use
 * the Row primitive, use the spacing ramp, route scroll writes through
 * auto-scroll, render collections as a DataView. They exist to keep the app's
 * composition coherent. A test suite and a Playwright driver are not part of
 * that composition: they *observe* the app from outside, and for e2e the
 * boundary rules actively FORBID importing the primitives those rules point you
 * at (the `e2e` runtime may reach `core` and other `e2e` barrels, never `web`).
 * A rule whose remedy is unreachable from the file it fires on is not enforcing
 * architecture — it is just noise that pushes authors toward inline disables.
 *
 * So contributed rules are off here by default. A rule that catches a genuine
 * BUG rather than a design deviation (a floating promise, a swallowed error)
 * opts back in via `enforceEverywhere` in its lint barrel — see
 * `lint/core/build-lint-config.ts` and the promise-safety contribution.
 *
 * This does NOT relax the base config: typescript-eslint and the react-hooks /
 * React Compiler diagnostics still apply to every file, everywhere.
 */
export const NON_APP_FILE_CATEGORIES: readonly FileCategory[] = ["test", "e2e"];

/** The globs of every category in `categories`, in order, deduped. */
export function categoryGlobs(categories: readonly FileCategory[]): string[] {
  return [...new Set(categories.flatMap((c) => FILE_CATEGORY_GLOBS[c]))];
}

/**
 * Compile one of the category globs to an anchored RegExp over a repo-relative
 * path. Only the syntax the table above uses is supported, and anything else
 * throws: a glob this compiler half-understood would match the wrong files.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (glob.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 3;
    } else if (glob.startsWith("/**", i) && i + 3 === glob.length) {
      re += "/.*";
      i += 3;
    } else if (glob.startsWith("**", i)) {
      throw new Error(
        `globToRegExp: "**" must be a whole path segment, in "${glob}"`,
      );
    } else if (c === "*") {
      re += "[^/]*";
      i += 1;
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1)
        throw new Error(`globToRegExp: unclosed "{" in "${glob}"`);
      const alts = glob.slice(i + 1, end).split(",");
      re += `(?:${alts.map(escapeRe).join("|")})`;
      i = end + 1;
    } else if (c === "?" || c === "[" || c === "!") {
      throw new Error(`globToRegExp: unsupported "${c}" in "${glob}"`);
    } else {
      re += escapeRe(c);
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

const CATEGORY_RES: Readonly<Record<FileCategory, readonly RegExp[]>> =
  Object.fromEntries(
    FILE_CATEGORIES.map((c) => [c, FILE_CATEGORY_GLOBS[c].map(globToRegExp)]),
  ) as Record<FileCategory, RegExp[]>;

/** Whether the repo-relative `path` belongs to `category`. */
export function isInCategory(path: string, category: FileCategory): boolean {
  return CATEGORY_RES[category].some((re) => re.test(path));
}

/** Whether the repo-relative `path` belongs to any of `categories`. */
export function isInAnyCategory(
  path: string,
  categories: readonly FileCategory[],
): boolean {
  return categories.some((c) => isInCategory(path, c));
}
