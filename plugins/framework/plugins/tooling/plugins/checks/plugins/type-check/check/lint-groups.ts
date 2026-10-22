// Which rules a file's lint result depends on, split into GROUPS so a change
// re-lints only what it can affect.
//
// A file's lint messages are a function of (a) the file's own text — the key
// of its store entry (`../shared/lint-results`); (b) for the type-aware rules only, the
// declarations it can see — its result key (`../shared/name-walk.ts`);
// and (c) the rules that ran on it, keyed here. (c) used to be ONE global hash
// over every `lint/`, `exempt/`, tsconfig, lockfile and `.d.ts` file, so a
// change to any of them flipped every file's key and the worker re-linted all
// ~11.4k files (12–16 CPU-min, a 17–22 GB footprint). On main, 61 of 226
// commits in the 7 days to 2026-10-15 did that — and not one of the 37 lockfile
// edits among them changed an npm resolution. So (c) is split:
//
//   - the ENGINE, what every rule's result depends on: the lint config builder
//     and what it imports, this check's own worker, the lockfile's npm
//     resolutions, the root tsconfigs, ambient `.d.ts`, dependency patches,
//     and what rules read from the lint data files (`lintDataKey`). Folded
//     into every group below.
//   - the TYPED ENGINE, what only a result that reads types depends on: the
//     two-program check that computes each file's result key, and the emit
//     options that decide what a `.d.ts` says. Folded into every typed part and
//     every directive file's whole result, so editing them re-runs no
//     syntactic result.
//   - the BASE group: the rules the config builder enables itself
//     (typescript-eslint, react-hooks, eslint core) — the engine alone.
//   - one group per lint CONTRIBUTION (`plugins/<p>/lint/index.ts`): its own
//     import closure. A rule's `*.test.ts` is not in it; a helper the rule
//     imports from outside `lint/` is.
//
// Each group's fingerprint keys that group's SYNTACTIC rules, which read the
// text alone. A group that holds a type-aware rule also has a TYPED part — its
// type-aware rules — keyed on `typedGroupFps` (the group's fingerprint and the
// typed engine) together with the file's result key. One typed part per
// group, like the syntactic ones, so editing one type-aware rule re-runs that
// group's typed part only; a file whose result key moved still runs all its
// stale typed parts in ONE pass, in the program holding it.
//
// Exemption manifests are in none of them: an exemption only decides which
// messages are DROPPED, so the result store keeps messages unfiltered and the
// current exemptions are applied when they are read (`./lint-verdict`).
//
// A file holding an eslint directive is one unit (`LINT_GROUP_ALL`): whether a
// disable directive is "unused" depends on every rule, so its result is keyed
// on every group at once (and its result key) and it is re-linted whole.
//
// Every file in a group is hashed by its VERSION — its git blob sha in the
// run's tree (`../shared/repo-view.ts`) — so hashing a group reads nothing. Its
// MEMBERS are found by walking the import closures of the config builder and
// of each contribution's entry alone, parsing only the files on them and
// resolving specifiers against the tree (never the disk). They used to be read
// off an import graph of the whole repo — every lintable file read and parsed,
// up to five `existsSync` per specifier — built every run for these few
// closures (3 CPU-s per run, measured on 2026-10-21).
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
import { LINT_GROUP_ALL, LINT_GROUP_BASE } from "../core";
import { lockfileLintDigest } from "../shared/lockfile";
import type { TypeAwareGroups } from "../shared/lint-results";
import type { RepoView } from "../shared/repo-view";
import { producerSources } from "../shared/tsc-engine";
import {
  extractImportSpecifiers,
  isLintable,
  resolveSpecifier,
} from "./import-graph";

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
 * The engine inputs the import graph cannot see: config files rather than
 * modules. The root tsconfigs only — every other `tsconfig*.json` in the tree
 * is a rule test's fixture (`lint/**\/tsconfig.case.json`), which no rule reads
 * at check time.
 *
 * Not the repo's `.d.ts`: a syntactic rule reads the file's own text, and a
 * typed part is keyed on the file's result key, which holds every `.d.ts` the
 * file can see — a global one through the global hash, an ambient or module
 * one as a use (`../shared/name-check.ts` `declScope`). As engine, an edit to
 * any `.d.ts` re-linted every group on every file.
 */
function isEngineConfigFile(rel: string): boolean {
  if (!rel.includes("/")) {
    if (rel === "package.json") return true;
    if (rel.startsWith("tsconfig") && rel.endsWith(".json")) return true;
  }
  if (rel.startsWith("patches/")) return true;
  return false;
}

/** This file, repo-relative: how the checkout whose code RUNS is found. */
const OWN_PATH =
  "plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/lint-groups.ts";

/**
 * The root of the checkout this code runs from. The rules a group fingerprints
 * are CODE — the config builder, the contributions, this check's worker —
 * loaded from here, so their versions are read from this checkout's tree. For
 * a check run that is the checked tree itself; a test checks a fixture with
 * the repo's own rules.
 */
export function codeCheckoutRoot(): string {
  const self = import.meta.path.split("\\").join("/");
  if (!self.endsWith(`/${OWN_PATH}`)) {
    throw new Error(
      `type-check: lint-groups.ts runs from ${self}, not from <checkout>/${OWN_PATH} — update OWN_PATH`,
    );
  }
  return self.slice(0, -OWN_PATH.length - 1);
}

/** Repo-relative paths (in the code checkout) of files beside this one. */
function ownSources(files: readonly string[]): string[] {
  return files.map((f) =>
    relative(codeCheckoutRoot(), join(import.meta.dir, f))
      .split("\\")
      .join("/"),
  );
}

/**
 * This check's worker, whose lint loop is engine too. The file alone, not its
 * imports: those are the spawn protocol and process plumbing, which cannot
 * change a message — and the typed engine below.
 */
const WORKER_SOURCES = ["../shared/worker.ts"];

/**
 * The typed engine: what decides the types a typed rule reads — the modules
 * that build the programs it runs in and the `.d.ts` they serve, and the emit
 * options (`producerSources()`, derived from their imports). Not the walk:
 * which results are reused is the result key's business, and the walk's
 * plumbing does not change a type. (Each result key folds in the same files
 * through the compiler's engine, `tscEngineFp`; naming them here keeps the
 * rules half honest on its own.)
 */
const TYPED_ENGINE_SOURCES = producerSources().map((f) => `../shared/${f}`);

export interface LintGroups {
  /**
   * Every group's fingerprint, by group id: `LINT_GROUP_BASE` and each
   * contribution's plugin path. Each folds in the engine.
   */
  fps: Map<string, string>;
  /** How many files the engine's fingerprint covers (for the transcript). */
  engineFiles: number;
  /** How many files the closure walks parsed (for the transcript). */
  parsedFiles: number;
  /** The typed engine's fingerprint: folded into every part that reads types. */
  typedEngineFp: string;
  /**
   * The rules half of a directive file's single `LINT_GROUP_ALL` result key: a
   * hash of every group's fingerprint and the typed engine, so a change to any
   * rule re-lints it whole.
   */
  allFp: string;
}

/**
 * The rules half of each typed part's key, by group: one per group that holds a
 * type-aware rule (`LINT_GROUP_BASE` first, then contributions in path order),
 * each the group's fingerprint and the typed engine — so an edit to one
 * type-aware contribution stales that group's typed part only, and one to a
 * syntactic-only contribution none.
 *
 * Throws on a type-aware contribution with no group: the loaded contributions
 * and the generated registry the groups come from disagree, and a typed key
 * that silently left one out would keep a stale result.
 */
export function typedGroupFps(
  groups: LintGroups,
  typeAware: TypeAwareGroups,
): Map<string, string> {
  const members = [
    ...(typeAware.base ? [LINT_GROUP_BASE] : []),
    ...[...typeAware.contributions].sort(),
  ];
  return new Map(
    members.map((g) => {
      const fp = groups.fps.get(g);
      if (fp === undefined) {
        throw new Error(
          `type-check: the type-aware lint contribution "${g}" has no rule group — the loaded contributions and lint.generated.ts disagree`,
        );
      }
      return [g, groupHash(`(types)\n${g}\n${fp}\n${groups.typedEngineFp}`)];
    }),
  );
}

/**
 * The import closures of a tree, walked on demand: each file on a walk is
 * parsed once (its specifiers resolved against the view), every other file
 * never. Only a LINTABLE file's imports are followed — a generated registry or
 * a `prototypes/` file is a member of a closure that reaches it, not a way
 * through it — matching the graph this replaced, which held edges out of
 * lintable files alone.
 */
export function lintClosures(view: RepoView) {
  const deps = new Map<string, readonly string[]>();
  const depsOf = (rel: string): readonly string[] => {
    let d = deps.get(rel);
    if (d === undefined) {
      const out = new Set<string>();
      if (isLintable(rel)) {
        for (const spec of extractImportSpecifiers(view.readText(rel))) {
          const to = resolveSpecifier(rel, spec, view.isFile);
          if (to !== null && to !== rel) out.add(to);
        }
      }
      d = [...out];
      deps.set(rel, d);
    }
    return d;
  };
  return {
    /** How many files the walks have parsed so far. */
    parsed: (): number => deps.size,
    /**
     * Forward import closure of `start`, not descending into `stop` (files the
     * engine already covers) nor into a generated registry. Cycle-safe.
     *
     * Registries are skipped because what they enumerate is keyed elsewhere:
     * the lint contributions are groups of their own, the exemption manifests
     * are applied at read time, and the exemptable-rule-id union is a type.
     * Followed, `lint.generated.ts` alone would put every contribution into
     * the engine — and adding any rule anywhere would re-lint the whole repo
     * again.
     */
    of(start: string, stop: ReadonlySet<string>): Set<string> {
      if (!view.isFile(start)) {
        throw new Error(
          `type-check: lint group root ${start} is not in the checked tree ${view.treeHash}`,
        );
      }
      const visited = new Set<string>();
      const stack = [start];
      while (stack.length) {
        const cur = stack.pop()!;
        if (visited.has(cur)) continue;
        visited.add(cur);
        for (const dep of depsOf(cur)) {
          if (visited.has(dep) || stop.has(dep)) continue;
          if (dep.endsWith(".generated.ts")) continue;
          stack.push(dep);
        }
      }
      return visited;
    },
  };
}

/** A set of files as hashed: each path with its version, sorted. */
function body(files: Iterable<string>, view: RepoView): string {
  return [...files]
    .sort()
    .map((f) => {
      const v = view.version(f);
      if (v === undefined) {
        throw new Error(
          `type-check: lint engine file ${f} is not in the checked tree ${view.treeHash}`,
        );
      }
      return `${f}\0${v}`;
    })
    .join("\n");
}

/**
 * Compute the engine and every group's fingerprint for this tree. `view` is the
 * checked tree — its config files (tsconfigs, `package.json`, ambient `.d.ts`,
 * patches, the lockfile, the lint data files) are what the rules run against;
 * `code` is the tree of the checkout the rules run FROM (`codeCheckoutRoot`) —
 * the same tree on a check run, the repo's own beside a test's fixture.
 */
export function computeLintGroups(
  view: RepoView,
  code: RepoView = view,
): LintGroups {
  const closures = lintClosures(code);

  // The engine: the config builder's import closure and the worker (code),
  // plus the config files no import names, plus the lockfile's resolutions
  // and what rules read from the lint data files (the checked tree).
  const engineCode = closures.of(LINT_CONFIG_SOURCE, new Set());
  for (const f of ownSources(WORKER_SOURCES)) engineCode.add(f);
  const engineConfig = view.files().filter(isEngineConfigFile);
  const engine = new Set([...engineCode, ...engineConfig]);
  const lock = view.isFile("bun.lock")
    ? lockfileLintDigest(view.readText("bun.lock"))
    : "";
  const engineFp = sha256(
    `lock:${lock}\ndata:${lintDataKey(view.root)}\n${body(engineCode, code)}\n${body(engineConfig, view)}`,
  );

  const fps = new Map<string, string>();
  fps.set(LINT_GROUP_BASE, groupHash(`${LINT_GROUP_BASE}\n${engineFp}`));
  for (const pluginPath of lintContributionPaths()) {
    const entry = `plugins/${pluginPath}/lint/index.ts`;
    const closure = closures.of(entry, engine);
    fps.set(
      pluginPath,
      groupHash(`${pluginPath}\n${engineFp}\n${body(closure, code)}`),
    );
  }
  const typedEngineFp = groupHash(
    `(typed engine)\n${body(ownSources(TYPED_ENGINE_SOURCES), code)}`,
  );
  const allFp = groupHash(
    `${LINT_GROUP_ALL}\n${typedEngineFp}\n${[...fps].map(([g, fp]) => `${g}\0${fp}`).join("\n")}`,
  );
  return {
    fps,
    engineFiles: engine.size,
    parsedFiles: closures.parsed(),
    typedEngineFp,
    allFp,
  };
}

/**
 * The key of `typeAwareLintGroups`' answer: what it is a function of. Which
 * groups hold a type-aware rule is decided by each contribution's rules and
 * the builder's own (each group's closure, and the engine every group folds
 * in: the builder, its classifier, the lockfile pinning typescript-eslint),
 * and by which contributions exist — every group's fingerprint, by name. The
 * typed engine rides along so the key and every typed part move together.
 * Loading the contributions to learn it costs ~1.2 CPU-s, so a run whose
 * groups all stood reads the answer back instead.
 */
export function typeAwareKey(groups: LintGroups): string {
  return sha256(
    [
      "type-aware",
      groups.typedEngineFp,
      ...[...groups.fps].map(([g, fp]) => `${g}\0${fp}`).sort(),
    ].join("\n"),
  );
}
