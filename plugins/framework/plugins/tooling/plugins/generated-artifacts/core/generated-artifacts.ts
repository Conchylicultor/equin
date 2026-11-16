/**
 * The merge driver `.gitattributes` assigns a generated artifact: the script
 * that takes the upstream side and leaves a marker for a normalize pass to
 * regenerate from the merged sources (`plugins/framework/plugins/cli/scripts/`).
 */
export type RegenDriver = "regen-generated" | "regen-migrations";

export interface GeneratedArtifact {
  /** A `.gitattributes` path pattern (`*` within a segment, `**` across them), repo-relative. */
  readonly pattern: string;
  readonly driver: RegenDriver;
}

/** Every generated `.ts` artifact is named this way. */
export const GENERATED_TS_SUFFIX = ".generated.ts";

/**
 * Every committed file a build or the migration generator writes, never a
 * person — in `.gitattributes` order. The `generated-artifacts-attributed`
 * check holds the file's `merge=regen-*` lines equal to this list.
 */
export const GENERATED_ARTIFACTS: readonly GeneratedArtifact[] = [
  { pattern: "docs/plugins-compact.md", driver: "regen-generated" },
  { pattern: "docs/plugins-details.md", driver: "regen-generated" },
  { pattern: "docs/routes.md", driver: "regen-generated" },
  { pattern: "plugins/**/REFERENCE.md", driver: "regen-generated" },
  { pattern: `plugins/**/*${GENERATED_TS_SUFFIX}`, driver: "regen-generated" },
  { pattern: "config/**/*.origin.jsonc", driver: "regen-generated" },
  {
    pattern: "plugins/database/plugins/migrations/data/*.sql",
    driver: "regen-migrations",
  },
  {
    pattern: "plugins/database/plugins/migrations/data/meta/_journal.json",
    driver: "regen-migrations",
  },
  {
    pattern:
      "plugins/database/plugins/migrations/data/meta/schema.snapshot.json",
    driver: "regen-migrations",
  },
  {
    pattern: "plugins/database/plugins/migrations/data/meta/*_snapshot.json",
    driver: "regen-migrations",
  },
  {
    pattern: "plugins/database/plugins/migrations/data/meta/*_answers.json",
    driver: "regen-migrations",
  },
];

/**
 * A gitattributes path pattern as an anchored regex. Every pattern here holds
 * a `/`, so it matches from the repo root (gitattributes semantics); `**\/`
 * matches zero or more whole segments, `*` anything within one.
 */
function patternRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (pattern.startsWith("**/", i)) {
      re += "(?:[^/]+/)*";
      i += 2;
    } else if (c === "*") {
      re += "[^/]*";
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

const MATCHERS = GENERATED_ARTIFACTS.map((a) => patternRegExp(a.pattern));

/** Is this repo-relative POSIX path one of {@link GENERATED_ARTIFACTS}? */
export function isGeneratedArtifactPath(repoRelPath: string): boolean {
  const p = repoRelPath.startsWith("./") ? repoRelPath.slice(2) : repoRelPath;
  return MATCHERS.some((re) => re.test(p));
}
