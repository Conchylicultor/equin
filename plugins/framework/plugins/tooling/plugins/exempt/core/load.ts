import { resolveManifest } from "./resolve";
import type { ResolvedExemption } from "./types";

/**
 * The part of tooling/core's `RepoFiles` the loader reads. Structural, because
 * tooling/core imports this barrel's types and cannot be imported back.
 */
export interface ManifestSource {
  /** Absolute worktree root. */
  readonly root: string;
  /** Every file matching a git pathspec, superset-safe (`RepoFiles.glob`). */
  glob(pattern: string): readonly string[];
}

// A plugin's manifest: `plugins/<p>/exempt/index.ts`, `<p>` being a plugin path
// (`a`, `a/plugins/b`, …). The glob below is a superset; this is the definition.
const MANIFEST_PATH =
  /^plugins\/((?:[^/]+\/plugins\/)*[^/]+)\/exempt\/index\.ts$/;

/**
 * Every plugin's manifest in `files`, repo-relative, sorted — read off the file
 * set itself, never off a generated list of it. A registry of manifests was a
 * copy of this answer that only a build refreshed: deleting or moving a
 * manifest broke every lint and check until then, and a new one was silently
 * ignored. Through an input-keyed check's recording `ctx.repo()` this records
 * the manifest set as one glob fact, so adding or removing one invalidates a
 * cached PASS and nothing else does.
 */
export function exemptManifestPaths(
  files: Pick<ManifestSource, "glob">,
): string[] {
  return files
    .glob("plugins/**/exempt/index.ts")
    .filter((p) => MANIFEST_PATH.test(p));
}

/**
 * Load every manifest in `files`, validate it and resolve its paths. Fails
 * loudly, collecting every broken manifest into one error: a manifest that did
 * not load is indistinguishable from one exempting nothing, and that is exactly
 * how a rule would start firing — or a debt entry vanish from the burndown —
 * for no visible reason.
 *
 * Rule ids are checked only for shape here; whether each names a live,
 * non-closed rule is answered where the live rule set is known (the lint
 * config build, the check runner, `exempt:manifests-valid`).
 */
export async function loadExemptions(
  files: ManifestSource,
): Promise<ResolvedExemption[]> {
  const manifests = exemptManifestPaths(files).map((path) => ({
    path,
    plugin: MANIFEST_PATH.exec(path)![1]!,
  }));
  const settled = await Promise.allSettled(
    manifests.map(
      ({ path }) =>
        import(`${files.root}/${path}`) as Promise<{ default: unknown }>,
    ),
  );
  const out: ResolvedExemption[] = [];
  const failures: string[] = [];
  for (const [i, r] of settled.entries()) {
    const { path, plugin } = manifests[i]!;
    if (r.status === "rejected") {
      failures.push(
        `${path}: failed to load — ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
      );
      continue;
    }
    try {
      out.push(...resolveManifest(plugin, r.value.default));
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      failures.push(err.message);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `[exempt] ${failures.length} exemption manifest(s) failed:\n${failures.join("\n")}`,
    );
  }
  return out;
}

/** Whether `rule` is spelled as a lint rule id (`<ns>/<rule>`). Check ids never contain `/`. */
export function isLintRuleId(rule: string): boolean {
  return rule.includes("/");
}

/**
 * The problems with exemptions' rule ids against a live rule set: an id no
 * live rule declares, or one whose owner declared it `closed`. One function,
 * so the lint config build, the check runner and `exempt:manifests-valid`
 * cannot disagree about what a bad id is.
 */
export function ruleIdProblems(
  exemptions: readonly ResolvedExemption[],
  live: { known: ReadonlySet<string>; closed: ReadonlySet<string> },
): string[] {
  const problems: string[] = [];
  for (const e of exemptions) {
    if (live.closed.has(e.rule)) {
      problems.push(
        `${e.manifest} exempts "${e.path}" from ${e.rule}, which its owner declares closed — it admits no exemptions`,
      );
    } else if (!live.known.has(e.rule)) {
      problems.push(
        `${e.manifest} exempts "${e.path}" from ${e.rule}, which no lint rule or check declares exemptable`,
      );
    }
  }
  return problems;
}
