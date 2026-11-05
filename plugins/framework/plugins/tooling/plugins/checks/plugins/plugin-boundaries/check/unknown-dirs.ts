// R11: a plugin folder may only hold recognized zone directories.
//
// Both questions the rule asks — which subdirectories a plugin has, and whether
// one of them holds TypeScript — come from the run's single git-backed
// enumeration via `RepoTree`, never from a `readdirSync` walk. See ./repo-tree
// for why: the check is `inputKeyed`, so a directory the filesystem can see but
// the git tree snapshot cannot would raise a violation from content the cache
// key does not cover.

import type { RepoTree } from "./repo-tree";

export interface Violation {
  rule: string;
  file: string;
  message: string;
  fix?: string;
}

export interface UnknownDirOptions {
  /** Path from the `plugins/` root, e.g. `conversations/plugins/conversation-view`. */
  pluginRelPath: string;
  /** Same, for every plugin in the tree — child plugins are recognized from it. */
  allPluginRelPaths: readonly string[];
  /** The recognized zone names (derived, not hardcoded — see `standardPluginDirsIn`). */
  known: ReadonlySet<string>;
  repo: RepoTree;
}

export function collectUnknownDirViolations({
  pluginRelPath,
  allPluginRelPaths,
  known,
  repo,
}: UnknownDirOptions): Violation[] {
  // Child plugins live at `<plugin>/plugins/<child>` — their names appear as
  // direct subdirs of `<plugin>/plugins/`, not of `<plugin>/` itself, so they
  // won't trigger false positives here.
  const childPrefix = `${pluginRelPath}/plugins/`;
  const childPluginNames = new Set(
    allPluginRelPaths
      .filter(
        (other) =>
          other.startsWith(childPrefix) &&
          !other.slice(childPrefix.length).includes("/"),
      )
      .map((other) => other.slice(other.lastIndexOf("/") + 1)),
  );

  const pluginRel = `plugins/${pluginRelPath}`;
  const violations: Violation[] = [];
  for (const name of repo.subdirs(pluginRel)) {
    if (known.has(name)) continue;
    // A dot-directory is not a claim to be a zone, so it is excluded on
    // MEANING — unlike node_modules and build output, which are gone from the
    // enumeration already because .gitignore says so. `.claude/` is tracked, so
    // this rule cannot lean on gitignore to make dot-directories disappear.
    if (name.startsWith(".")) continue;
    if (childPluginNames.has(name)) continue;
    // Only flag directories that contain TS source files — non-code asset
    // directories (SQL migrations, shell scripts, etc.) are fine.
    if (!repo.containsTsFiles(`${pluginRel}/${name}`)) continue;
    violations.push({
      rule: "unknown-dir",
      file: `${pluginRel}/${name}/`,
      message: `unrecognized directory \`${name}/\` contains TypeScript files but is not a recognized zone`,
      fix: `plugin code must live in one of: ${[...known].join(", ")}. If this is a typo, rename it. If it's private shared code, use \`shared/\`.`,
    });
  }
  return violations;
}
