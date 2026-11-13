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
//   - the ENGINE, what every rule's result depends on: the import closure of
//     every module that runs ESLint (`lintEngineRoots`: the config builder and
//     this check's lint engine, found by what they import, never listed), the
//     npm code they load (below), the root tsconfigs and what rules read from
//     the lint data files (`lintDataKey`). Folded into every group below.
//   - the TYPED ENGINE, what only a result that reads types depends on: the
//     two-program check that computes each file's result key, and the emit
//     options that decide what a `.d.ts` says. Folded into every typed part and
//     every directive file's whole result, so editing them re-runs no
//     syntactic result.
//   - the BASE group: the rules the config builder enables itself
//     (typescript-eslint, react-hooks, eslint core) — the engine alone.
//   - one group per lint CONTRIBUTION (`plugins/<p>/lint/index.ts`): its own
//     import closure and the npm code it loads. A rule's `*.test.ts` is not in
//     it; a helper the rule imports from outside `lint/` is.
//
// NPM CODE counts by what a closure LOADS: the packages its files import by
// name, closed over their dependencies in `bun.lock`, with the patch files
// `bun.lock` applies to any of them (`lockfileNpmClosure`, `infra/deps/npm/lock-closure`). The whole
// lockfile and every `patches/` file used to be engine: a patch of
// graphile-worker or @parcel/watcher — which no rule loads — or a dependency
// added for a server feature re-linted every group of every file (8 of 20
// engine moves on main in the week to 2026-11-08,
// research/2026-11-08-global-lint-store-rewrites.md). The root `package.json`
// is not engine either: no rule reads it, and what it pins reaches a rule only
// through `bun.lock`.
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
// A file holding an eslint directive has one VERDICT (`LINT_GROUP_ALL`): a
// directive suppresses any rule's problem and is reported when it suppressed
// none, so the verdict is keyed on every group at once (and its result key).
// It is computed with no program, over the file's RAW typed parts (`rawFps`:
// its rules' problems before the directives), which are keyed per group like
// a split file's typed parts. So a rule edit re-runs a directive file's
// verdict without types, and only a typed part that moved needs a program —
// before, every rule edit re-linted all ~470 directive files whole in one
// program (+3.2 GB of worker peak, ~100 CPU-s; research/2026-11-12-global-type-check-worker-memory-split.md).
//
// A closure follows RUNTIME imports only (`runtimeImportSpecifiers`): an
// `import type` is erased before a rule runs, so what sits behind it cannot
// change a message. Followed, the engine took in the process plumbing a type
// named (host admission, spawn): 53 files on 2026-11-05, most of them unable
// to change a message, and every edit to one re-linted the whole tree.
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
import { isBuiltin } from "module";
import { join, relative } from "path";
import {
  LINT_CONFIG_SOURCE,
  lintContributionPaths,
  lintDataKey,
} from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { LINT_GROUP_ALL, LINT_GROUP_BASE } from "../core";
import { lockfileNpmClosure } from "@plugins/infra/plugins/deps/plugins/npm/plugins/lock-closure/core";
import type { TypeAwareGroups } from "../shared/lint-results";
import type { RepoView } from "../shared/repo-view";
import { producerSources } from "../shared/tsc-engine";
import {
  type ImportedNames,
  isLintable,
  pureBarrelReexports,
  resolveSpecifier,
  runtimeImports,
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
 * at check time. (Dependency patches count per closure, by the packages it
 * loads: `npmKey`.)
 *
 * Not the repo's `.d.ts`: a syntactic rule reads the file's own text, and a
 * typed part is keyed on the file's result key, which holds every `.d.ts` the
 * file can see — a global one through the global hash, an ambient or module
 * one as a use (`../shared/name-check.ts` `declScope`). As engine, an edit to
 * any `.d.ts` re-linted every group on every file.
 */
function isEngineConfigFile(rel: string): boolean {
  return (
    !rel.includes("/") && rel.startsWith("tsconfig") && rel.endsWith(".json")
  );
}

/**
 * The npm package a bare specifier loads (`@s/p/sub` → `@s/p`, `p/sub` → `p`),
 * or undefined for a runtime builtin (`node:fs`, `path`, `bun`, `bun:test`),
 * which is the runtime's, not the lockfile's.
 */
function npmPackageOf(spec: string): string | undefined {
  if (spec === "bun" || spec.startsWith("bun:") || isBuiltin(spec)) {
    return undefined;
  }
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** A specifier resolved against the repo, not `node_modules`. */
const isRepoSpecifier = (spec: string): boolean =>
  spec.startsWith("./") ||
  spec.startsWith("../") ||
  spec.startsWith("@plugins/") ||
  spec === "@" ||
  spec.startsWith("@/");

/** This file, repo-relative: how the checkout whose code RUNS is found. */
const OWN_PATH =
  "plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/lint-groups.ts";

/**
 * The root of the checkout this code runs from. The rules a group fingerprints
 * are CODE — the config builder, the contributions, this check's lint engine —
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
 * The package whose `Linter` turns a config and a text into messages. Every
 * module that loads it is where messages are made — the config builder (its
 * built-in rules), this check's lint engine (the `--quiet` filter, the message
 * shape, the per-group bucketing) — so the engine is rooted there, wherever
 * that code lives (`lintEngineRoots`).
 */
const LINTER_PACKAGE = "eslint";

/**
 * The modules this check's worker processes load that run ESLint: every
 * module in the run-time closure of `shared/` (where the worker and its batch
 * processes live) importing {@link LINTER_PACKAGE}, plus the config builder.
 * Derived, never listed: a lint loop moved into a new module, here or in
 * another plugin `shared/` reaches, is a root the moment it imports the
 * linter. (A hand-written list of the worker's files went stale when the loop
 * moved out of `worker.ts`, and an edit to the `--quiet` filter re-linted
 * nothing.)
 */
export function lintEngineRoots(
  closures: ReturnType<typeof lintClosures>,
  code: Pick<RepoView, "files">,
): string[] {
  const shared = `${ownSources(["../shared"])[0]!}/`;
  const runtime = code
    .files()
    .filter(
      (f) =>
        f.startsWith(shared) &&
        isLintable(f) &&
        !f.endsWith(".d.ts") &&
        !/\.test\.tsx?$/.test(f),
    );
  if (runtime.length === 0) {
    throw new Error(
      `type-check: no worker module under ${shared} in the code checkout — the lint engine has no roots`,
    );
  }
  const reach = new Set<string>();
  for (const f of runtime)
    for (const m of closures.of(f, new Set())) reach.add(m);
  const roots = new Set([LINT_CONFIG_SOURCE]);
  for (const m of reach) {
    if (closures.packagesOf([m]).has(LINTER_PACKAGE)) roots.add(m);
  }
  if (roots.size === 1) {
    throw new Error(
      `type-check: no module the worker loads imports ${LINTER_PACKAGE} — the lint loop moved where the engine cannot find it`,
    );
  }
  return [...roots].sort();
}

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
   * The rules half of a directive file's verdict key (`LINT_GROUP_ALL`): a hash
   * of every group's fingerprint and the typed engine, so a change to any rule
   * re-runs it — with no program, over its raw typed parts.
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
 * The rules half of each RAW typed part's key — a directive file's typed part
 * (`TypedParts` in `../core`): the typed part's own fingerprint, salted, so a
 * raw result (every problem before the directives, warnings included) is never
 * read as a split file's filtered one.
 */
export function rawTypedFps(
  typed: ReadonlyMap<string, string>,
): Map<string, string> {
  return new Map([...typed].map(([g, fp]) => [g, groupHash(`(raw)\n${fp}`)]));
}

/**
 * The import closures of a tree, walked on demand: each file on a walk is
 * parsed once (its specifiers resolved against the view), every other file
 * never. Only a LINTABLE file's imports are followed — a generated registry or
 * a `prototypes/` file is a member of a closure that reaches it, not a way
 * through it — matching the graph this replaced, which held edges out of
 * lintable files alone.
 *
 * A closure is walked BY NAME through pure barrels (`pureBarrelReexports`): a
 * module importing `{ a }` from a barrel reaches the barrel and the module
 * that exports `a`, not every module the barrel re-exports. So a closure is
 * the code its files can call, not every module the runtime evaluates beside
 * it: a builder importing one helper from `lint/core` does not take in that
 * barrel's file readers and process plumbing. What a module only EVALUATES
 * (an unused re-export's top-level code) is out — a module whose evaluation
 * changes a message must be reached by a name it exports.
 */
export function lintClosures(
  view: Pick<RepoView, "isFile" | "readText" | "treeHash">,
) {
  interface Facts {
    /** Each run-time import resolved into the repo, with the names it asks. */
    edges: readonly { to: string; names: ImportedNames }[];
    /** A pure barrel's re-exports, resolved; null for any other file. */
    barrel:
      | readonly {
          to: string;
          exports: ReadonlyMap<string, string | null> | "all";
        }[]
      | null;
    /** The npm packages it imports by name. */
    packages: readonly string[];
  }
  const facts = new Map<string, Facts>();
  const factsOf = (rel: string): Facts => {
    let f = facts.get(rel);
    if (f === undefined) {
      const edges: { to: string; names: ImportedNames }[] = [];
      const pkgs = new Set<string>();
      let barrel: Facts["barrel"] = null;
      if (isLintable(rel)) {
        const src = view.readText(rel);
        for (const { specifier: spec, names } of runtimeImports(src)) {
          const to = resolveSpecifier(rel, spec, view.isFile);
          if (to !== null) {
            if (to !== rel) edges.push({ to, names });
            continue;
          }
          // A missing repo file is no npm code, and neither is a computed
          // `import(\`${…}\`)` (the builder's load of a registry by path).
          if (isRepoSpecifier(spec) || spec.includes("${")) continue;
          const pkg = npmPackageOf(spec);
          if (pkg !== undefined) pkgs.add(pkg);
        }
        const reexports = pureBarrelReexports(rel, src);
        if (reexports !== null) {
          barrel = reexports.flatMap(({ specifier, exports }) => {
            const to = resolveSpecifier(rel, specifier, view.isFile);
            return to === null || to === rel ? [] : [{ to, exports }];
          });
        }
      }
      f = { edges, barrel, packages: [...pkgs] };
      facts.set(rel, f);
    }
    return f;
  };
  return {
    /** How many files the walks have parsed so far. */
    parsed: (): number => facts.size,
    /** The npm packages the files of a closure (`of`'s answer) import by name. */
    packagesOf(files: Iterable<string>): Set<string> {
      const out = new Set<string>();
      for (const f of files) for (const p of factsOf(f).packages) out.add(p);
      return out;
    },
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
      // The names asked of each visited file so far; `"all"` once it is
      // followed whole (every file but a pure barrel is, on its first visit).
      const asked = new Map<string, Set<string> | "all">();
      const stack: { file: string; names: ImportedNames }[] = [
        { file: start, names: "all" },
      ];
      while (stack.length) {
        const { file, names } = stack.pop()!;
        const before = asked.get(file);
        if (before === "all") continue;
        const { edges, barrel } = factsOf(file);
        const follow = (to: string, n: ImportedNames): void => {
          if (to.endsWith(".generated.ts")) return;
          // A stop file is covered whole — unless it is a pure barrel, which
          // the stop's own walk entered for ITS names only: walked here by
          // name, the re-exports it was not asked for are not covered.
          if (stop.has(to) && factsOf(to).barrel === null) return;
          if (n !== "all" && n.size === 0) return;
          stack.push({ file: to, names: n });
        };
        if (barrel === null || names === "all") {
          asked.set(file, "all");
          if (barrel === null) {
            for (const e of edges) follow(e.to, e.names);
          } else {
            for (const r of barrel) {
              follow(
                r.to,
                r.exports === "all" || [...r.exports.values()].includes(null)
                  ? "all"
                  : new Set(r.exports.values() as Iterable<string>),
              );
            }
          }
          continue;
        }
        // A pure barrel asked for some names: follow only the re-exports
        // that supply the ones not asked before. A name none supplies is a
        // type (its re-export is `export type`), which runs no code.
        const seen = before ?? new Set<string>();
        const fresh = [...names].filter((n) => !seen.has(n));
        if (before !== undefined && fresh.length === 0) continue;
        for (const n of fresh) seen.add(n);
        asked.set(file, seen);
        for (const r of barrel) {
          if (r.exports === "all") {
            follow(r.to, new Set(fresh));
            continue;
          }
          const exports = r.exports;
          if (fresh.some((n) => exports.get(n) === null)) {
            follow(r.to, "all");
            continue;
          }
          follow(
            r.to,
            new Set(
              fresh.flatMap((n) => {
                const own = exports.get(n);
                return own === undefined || own === null ? [] : [own];
              }),
            ),
          );
        }
      }
      return new Set(asked.keys());
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
 * The npm code a closure loads, as text to hash: the lock entries its
 * packages reach (`lockfileNpmClosure`) and each patch applied to one of them,
 * by version — read from the CODE checkout's tree, whose `node_modules` the
 * rules run with (the checked tree itself on a check run). Throws on a package the lockfile does not hold — code that
 * imports it cannot run, and a key that left it out would not move when it
 * is installed.
 */
function npmKey(
  label: string,
  packages: ReadonlySet<string>,
  view: RepoView,
): string {
  if (packages.size === 0) return "";
  if (!view.isFile("bun.lock")) {
    throw new Error(
      `type-check: lint ${label} imports npm packages (${[...packages].sort().slice(0, 3).join(", ")}) and the checked tree ${view.treeHash} has no bun.lock`,
    );
  }
  const closure = lockfileNpmClosure(view.readText("bun.lock"), packages);
  if (closure.missing.length > 0) {
    throw new Error(
      `type-check: lint ${label} imports ${closure.missing.join(", ")}, which bun.lock does not hold`,
    );
  }
  return `${sha256(closure.entries.join("\n"))}\n${body(closure.patches, view)}`;
}

/**
 * Compute the engine and every group's fingerprint for this tree. `view` is the
 * checked tree — its config files (the root tsconfigs, the lint data files)
 * are what the rules run against; `code` is the tree of the checkout the rules
 * run FROM (`codeCheckoutRoot`): their sources, and the lockfile and patches
 * its `node_modules` was installed from — the same tree on a check run, the
 * repo's own beside a test's fixture.
 */
export async function computeLintGroups(
  view: RepoView,
  code: RepoView = view,
): Promise<LintGroups> {
  const closures = lintClosures(code);

  // The engine: the closure of every module that runs ESLint (the config
  // builder, the lint engine) and the npm code they load (code), plus the
  // config files no import names and what rules read from the lint data
  // files (the checked tree).
  const engineCode = new Set<string>();
  for (const root of lintEngineRoots(closures, code)) {
    for (const f of closures.of(root, new Set())) engineCode.add(f);
  }
  const engineConfig = view.files().filter(isEngineConfigFile);
  const engine = new Set([...engineCode, ...engineConfig]);
  const engineFp = sha256(
    `npm:${npmKey("engine", closures.packagesOf(engineCode), code)}\ndata:${lintDataKey(view.root)}\n${body(engineCode, code)}\n${body(engineConfig, view)}`,
  );

  const fps = new Map<string, string>();
  fps.set(LINT_GROUP_BASE, groupHash(`${LINT_GROUP_BASE}\n${engineFp}`));
  for (const pluginPath of await lintContributionPaths()) {
    const entry = `plugins/${pluginPath}/lint/index.ts`;
    const closure = closures.of(entry, engine);
    fps.set(
      pluginPath,
      groupHash(
        `${pluginPath}\n${engineFp}\n${body(closure, code)}\nnpm:${npmKey(pluginPath, closures.packagesOf(closure), code)}`,
      ),
    );
  }
  const typedEngineFp = groupHash(
    `(typed engine)\n${body(ownSources(TYPED_ENGINE_SOURCES), code)}`,
  );
  const allFp = groupHash(
    `${LINT_GROUP_ALL} combined\n${typedEngineFp}\n${[...fps].map(([g, fp]) => `${g}\0${fp}`).join("\n")}`,
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
