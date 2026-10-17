// Which rules a file's lint result depends on, split into GROUPS so a change
// re-lints only what it can affect.
//
// A file's lint messages are a function of (a) the file's own text — the key
// of its store entry (`./lint-results`); (b) for the type-aware rules only, the
// declarations it can see — its type fingerprint (`../shared/type-fingerprint`);
// and (c) the rules that ran on it, keyed here. (c) used to be ONE global hash
// over every `lint/`, `exempt/`, tsconfig, lockfile and `.d.ts` file, so a
// change to any of them flipped every file's key and the worker re-linted all
// ~11.4k files (12–16 CPU-min, a 17–22 GB footprint). On main, 61 of 226
// commits in the 7 days to 2026-10-15 did that — and not one of the 37 lockfile
// edits among them changed an npm resolution. So (c) is split:
//
//   - the ENGINE, what every rule's result depends on: the lint config builder
//     and what it imports, this check's own worker and type fingerprint, the
//     lockfile's npm resolutions, the root tsconfigs, ambient `.d.ts`,
//     dependency patches, and what rules read from the lint data files
//     (`lintDataKey`). Folded into every group below.
//   - the BASE group: the rules the config builder enables itself
//     (typescript-eslint, react-hooks, eslint core) — the engine alone.
//   - one group per lint CONTRIBUTION (`plugins/<p>/lint/index.ts`): its own
//     import closure. A rule's `*.test.ts` is not in it; a helper the rule
//     imports from outside `lint/` is.
//
// Each group's fingerprint keys that group's SYNTACTIC rules, which read the
// text alone. The type-aware rules of every group run as ONE more part,
// `LINT_GROUP_TYPED`, keyed on `typedFp` — the fingerprints of just the groups
// that hold a type-aware rule — together with the file's type fingerprint. One
// typed part, not one per group: a typed-rule edit is rare (a dozen rules), it
// costs resolving types for every file whichever typed rule changed, and the
// worker's job stays small.
//
// Exemption manifests are in none of them: an exemption only decides which
// messages are DROPPED, so the result store keeps messages unfiltered and the
// current exemptions are applied when they are read (`./lint-verdict`).
//
// A file holding an eslint directive is one unit (`LINT_GROUP_ALL`): whether a
// disable directive is "unused" depends on every rule, so its result is keyed
// on every group at once (and its type fingerprint) and it is re-linted whole.
//
// See research/2026-10-15-global-lint-cache-per-contribution.md and
// research/2026-10-17-global-lint-keyed-on-what-it-reads.md.

import { createHash } from "crypto";
import { join, relative } from "path";
import {
  LINT_CONFIG_SOURCE,
  lintContributionPaths,
  lintDataKey,
} from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { LINT_GROUP_ALL, LINT_GROUP_BASE, LINT_GROUP_TYPED } from "../core";
import { safeRead, type ImportGraphs } from "./import-graph";
import type { TreeListing } from "./fingerprint";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * A group fingerprint, shortened. A file's store entry lists one per group it
 * has a result for (~100), and the store is read for every lintable file on
 * every run, so the full 64 hex digits would be most of what each run reads.
 * 64 bits keeps a collision between the few versions one file ever holds out of
 * reach.
 */
function groupHash(s: string): string {
  return sha256(s).slice(0, 16);
}

/**
 * The lockfile as far as linting can tell: its content minus the top-level
 * `"workspaces"` section, minus every `@workspace:` package line, minus blank
 * lines. What is left is the npm resolutions (and overrides, patches) — what
 * decides which parser, plugins and `@types` the rules run against.
 *
 * Adding a plugin with a `package.json` adds a workspace entry and nothing
 * else; that was every one of the 37 lockfile edits on main in the week this
 * was written, and each of them re-linted the whole repo.
 *
 * bun writes this file in one deterministic text layout, which is what lets the
 * filter work by line. A layout it does not recognise (no `"workspaces"` opener
 * at the expected indent) hashes the whole file: the cost of a wrong guess is
 * then an over-invalidation, never a stale result.
 */
export function lockfileLintDigest(text: string): string {
  const lines = text.split("\n");
  if (!lines.includes('  "workspaces": {')) return sha256(text);
  const kept: string[] = [];
  let inWorkspaces = false;
  for (const line of lines) {
    if (inWorkspaces) {
      if (line === "  },") inWorkspaces = false;
      continue;
    }
    if (line === '  "workspaces": {') {
      inWorkspaces = true;
      continue;
    }
    if (line.trim() === "" || line.includes("@workspace:")) continue;
    kept.push(line);
  }
  return sha256(kept.join("\n"));
}

/**
 * The engine inputs the import graph cannot see: config files rather than
 * modules. The root tsconfigs only — every other `tsconfig*.json` in the tree
 * is a rule test's fixture (`lint/**\/tsconfig.case.json`), which no rule reads
 * at check time.
 */
function isEngineConfigFile(rel: string): boolean {
  if (!rel.includes("/")) {
    if (rel === "package.json") return true;
    if (rel.startsWith("tsconfig") && rel.endsWith(".json")) return true;
  }
  if (rel.endsWith(".d.ts")) return true;
  if (rel.startsWith("patches/")) return true;
  return false;
}

/**
 * Repo-relative paths of this check's worker, whose lint loop is engine too,
 * of the type fingerprint, which decides when a typed result is reused, and of
 * the emit options, which decide what the signatures it reads say. The files
 * alone, not their imports: those are the spawn protocol and process plumbing,
 * which cannot change a message.
 */
function workerSources(root: string): string[] {
  return [
    "../shared/worker.ts",
    "../shared/type-fingerprint.ts",
    "../shared/emit-options.ts",
  ].map((f) =>
    relative(root, join(import.meta.dir, f))
      .split("\\")
      .join("/"),
  );
}

/** A repo-relative file's content hash, memoized for the run. */
export type ContentHasher = (rel: string) => string;

export interface LintGroups {
  /**
   * Every group's fingerprint, by group id: `LINT_GROUP_BASE` and each
   * contribution's plugin path. Each folds in the engine.
   */
  fps: Map<string, string>;
  /** How many files the engine's fingerprint covers (for the transcript). */
  engineFiles: number;
  /**
   * The rules half of a directive file's single `LINT_GROUP_ALL` result key: a
   * hash of every group's fingerprint, so a change to any rule re-lints it
   * whole.
   */
  allFp: string;
}

/** The groups holding at least one enabled type-aware rule (`typeAwareLintGroups`). */
export interface TypeAwareGroups {
  base: boolean;
  contributions: ReadonlySet<string>;
}

/**
 * The rules half of the typed part's key (`LINT_GROUP_TYPED`): the
 * fingerprints of the groups that hold a type-aware rule, so an edit to a
 * syntactic-only contribution leaves every typed result standing.
 *
 * Throws on a type-aware contribution with no group: the loaded contributions
 * and the generated registry the groups come from disagree, and a typed key
 * that silently left one out would keep a stale result.
 */
export function typedGroupFp(
  groups: LintGroups,
  typeAware: TypeAwareGroups,
): string {
  const members = [
    ...(typeAware.base ? [LINT_GROUP_BASE] : []),
    ...[...typeAware.contributions].sort(),
  ];
  const lines = members.map((g) => {
    const fp = groups.fps.get(g);
    if (fp === undefined) {
      throw new Error(
        `type-check: the type-aware lint contribution "${g}" has no rule group — the loaded contributions and lint.generated.ts disagree`,
      );
    }
    return `${g}\0${fp}`;
  });
  return groupHash(`${LINT_GROUP_TYPED}\n${lines.join("\n")}`);
}

/**
 * Forward import closure of `start`, not descending into `stop` (files the
 * engine already covers) nor into a generated registry. Cycle-safe.
 *
 * Registries are skipped because what they enumerate is keyed elsewhere: the
 * lint contributions are groups of their own, the exemption manifests are
 * applied at read time, and the exemptable-rule-id union is a type. Followed,
 * `lint.generated.ts` alone would put every contribution into the engine — and
 * adding any rule anywhere would re-lint the whole repo again.
 */
function closureOf(
  graphs: ImportGraphs,
  start: string,
  stop: ReadonlySet<string>,
): Set<string> {
  const visited = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const dep of graphs.forward.get(cur) ?? []) {
      if (visited.has(dep) || stop.has(dep)) continue;
      if (dep.endsWith(".generated.ts")) continue;
      stack.push(dep);
    }
  }
  return visited;
}

const body = (files: Iterable<string>, ch: ContentHasher): string =>
  [...files]
    .sort()
    .map((f) => `${f}\0${ch(f)}`)
    .join("\n");

/** Compute the engine and every group's fingerprint for this tree. */
export function computeLintGroups(
  listing: TreeListing,
  graphs: ImportGraphs,
  ch: ContentHasher,
): LintGroups {
  const { root } = listing;

  // The engine: the config builder's import closure and the worker, plus the
  // config files the graph cannot see, plus the lockfile's resolutions and
  // what rules read from the lint data files.
  const engine = closureOf(graphs, LINT_CONFIG_SOURCE, new Set());
  for (const f of workerSources(root)) engine.add(f);
  for (const rel of listing.files) if (isEngineConfigFile(rel)) engine.add(rel);
  const lock = listing.files.includes("bun.lock")
    ? lockfileLintDigest(safeRead(join(root, "bun.lock")) ?? "")
    : "";
  const engineFp = sha256(
    `lock:${lock}\ndata:${lintDataKey(root)}\n${body(engine, ch)}`,
  );

  const fps = new Map<string, string>();
  fps.set(LINT_GROUP_BASE, groupHash(`${LINT_GROUP_BASE}\n${engineFp}`));
  for (const pluginPath of lintContributionPaths()) {
    const entry = `plugins/${pluginPath}/lint/index.ts`;
    const closure = closureOf(graphs, entry, engine);
    fps.set(
      pluginPath,
      groupHash(`${pluginPath}\n${engineFp}\n${body(closure, ch)}`),
    );
  }
  const allFp = groupHash(
    `${LINT_GROUP_ALL}\n${[...fps].map(([g, fp]) => `${g}\0${fp}`).join("\n")}`,
  );
  return { fps, engineFiles: engine.size, allFp };
}
