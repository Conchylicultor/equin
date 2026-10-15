// Which inputs a file's type-aware lint result depends on, split into GROUPS so
// a change re-lints only what it can affect.
//
// A file's lint messages are a function of (a) the file and everything it
// imports — its closure fingerprint (`./fingerprint`) — and (b) the rules that
// ran on it. (b) used to be ONE global hash over every `lint/`, `exempt/`,
// tsconfig, lockfile and `.d.ts` file, so a change to any of them flipped every
// file's key and the worker re-linted all ~11.4k files (12–16 CPU-min, a
// 17–22 GB footprint). On main, 61 of 226 commits in the 7 days to 2026-10-15
// did that — and not one of the 37 lockfile edits among them changed an npm
// resolution. So (b) is split:
//
//   - the ENGINE, what every rule's result depends on: the lint config builder
//     and what it imports, this check's own worker, the lockfile's npm
//     resolutions, the root tsconfigs, ambient `.d.ts`, dependency patches, and
//     what rules read from the lint data files (`lintDataKey`). Folded into
//     every group below.
//   - the BASE group: the rules the config builder enables itself
//     (typescript-eslint, react-hooks, eslint core) — the engine alone.
//   - one group per lint CONTRIBUTION (`plugins/<p>/lint/index.ts`): its own
//     import closure. A rule's `*.test.ts` is not in it; a helper the rule
//     imports from outside `lint/` is.
//
// Exemption manifests are in none of them: an exemption only decides which
// messages are DROPPED, so the result store keeps messages unfiltered and the
// current exemptions are applied when they are read (`./lint-verdict`).
//
// A file holding an eslint directive is one unit (`LINT_GROUP_ALL`): whether a
// disable directive is "unused" depends on every rule, so its result is keyed
// on every group at once and it is always re-linted whole.
//
// See research/2026-10-15-global-lint-cache-per-contribution.md.

import { createHash } from "crypto";
import { join, relative } from "path";
import {
  LINT_CONFIG_SOURCE,
  lintContributionPaths,
  lintDataKey,
} from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { LINT_GROUP_ALL, LINT_GROUP_BASE } from "../core";
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
 * Repo-relative path of this check's worker, whose lint loop is engine too. The
 * file alone, not its imports: those are the spawn protocol and process
 * plumbing, which cannot change a message.
 */
function workerSource(root: string): string {
  return relative(root, join(import.meta.dir, "../shared/worker.ts"))
    .split("\\")
    .join("/");
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
   * The key of a directive file's single `LINT_GROUP_ALL` result: a hash of
   * every group's fingerprint, so a change to any rule re-lints it whole.
   */
  allFp: string;
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
  engine.add(workerSource(root));
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
