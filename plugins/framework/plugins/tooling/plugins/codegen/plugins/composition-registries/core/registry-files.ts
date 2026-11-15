import { readdir } from "@plugins/packages/plugins/timed-fs/core";
import { rm } from "node:fs/promises";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { basename, join, relative } from "path";
import { assertCompositionName } from "@plugins/plugin-meta/plugins/composition/core";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import { SERVER_CORE_RELATIVE } from "@plugins/infra/plugins/paths/core";
import {
  discoverCollectedDirsIn,
  type DiscoveredCollectedDir,
} from "@plugins/framework/plugins/tooling/plugins/collected-dir/plugins/discovery/core";
import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";

export function collectedDirRegistryPath(def: DiscoveredCollectedDir): AppPath {
  return joinAppPath(def.ownerDir, "core", `${def.dir}.generated.ts`);
}

// ── Composition (filtered) registries ──────────────────────────────
//
// A composition build emits gitignored siblings of the committed full
// registries — same export name, restricted to the composition's bundle. The
// committed `<dir>.generated.ts` files are never touched, so the build stays
// byte-identical and `plugins-registry-in-sync` + `git status` stay clean.
//
// There is exactly ONE spelling: PER-NAME `<dir>.composition.<name>.generated.ts`.
// Every producer (auto-serve AND release) keys its registries by composition id,
// so no checkout-global "this checkout is currently composition X" state exists
// and a release can never reconfigure another namespace's backend. The pre-S1
// singleton `<dir>.composition.generated.ts` spelling is gone entirely (S5): no
// path writes it, selects it, or reaps it, so a stray file of that name is inert.

// The registries that need a composition-filtered (closure-restricted) sibling.
// `web`/`server`/`machine` are the runtime registries the app actually loads at
// the import seam. `prewarm` is release-build-time-only — consumed by the asset-mirror
// release runner to bake each closure mirror's files into the bundle, never
// loaded by the served app — but it needs the same closure filtering so a
// release only pre-warms mirrors in the composition's closure. `deps` holds the
// on-demand dependency declarations: a release's compiled launcher reaches that
// registry (through `infra/deps`' `readyNow`), and each declaration's loader is
// a dynamic import the bundler follows — so the unfiltered registry pulled every
// plugin's dependency kinds into every release, Playwright included, whose
// `chromium-bidi` require fails `bun build --compile` (2026-10-14). Central is
// dropped per the F1 requirements; check/lint are build-time-only and never
// loaded into a served app.
//
// `prewarm` is in this ONE set (rather than a released-only sibling set)
// because release is its only consumer and release is now per-name too — which
// also means `listNamedCompositionRegistries` lists prewarm files, so
// worktree reclaim deletes them like any other.
export const COMPOSITION_RUNTIME_DIRS: ReadonlySet<string> = new Set([
  "web",
  "server",
  "machine",
  "prewarm",
  "deps",
]);

export function collectedDirNamedCompositionRegistryPath(
  def: DiscoveredCollectedDir,
  name: string,
): AppPath {
  assertCompositionName(name);
  return joinAppPath(
    def.ownerDir,
    "core",
    compositionRegistryFileName(def.dir, name),
  );
}

/**
 * The registry FILE NAME for one `<dir>` and one composition — the single fact
 * that main's registry is the committed `<dir>.generated.ts` and every
 * other composition's is the gitignored `<dir>.composition.<id>.generated.ts`.
 *
 * That equality is not a carve-out for main. It is exactly what Phase 1's
 * `plugins-registry-in-sync` check proves: the committed registry IS the
 * main composition's registry, re-derived from the filesystem on every
 * build and asserted byte-identical. So main is an ordinary composition
 * here, and a plain `build` and an explicit main-composition build are identical by
 * construction rather than by two code paths that agree.
 *
 * Every consumer asks THIS — the codegen writer, the backend's boot-time
 * selector, the web fleet planner, `release`'s compile-time alias — so no caller
 * can arrive at "the composition's registry" by spelling a filename and get main
 * wrong. Filename-shaped (rather than path-shaped) because `release` names the
 * file relative to the repo root and holds no `DiscoveredCollectedDir`;
 * `compositionRegistryPath` is the def-shaped wrapper for everyone else.
 */
export function compositionRegistryFileName(
  dir: string,
  composition: string,
): string {
  assertCompositionName(composition);
  return composition === MAIN_COMPOSITION_ID
    ? `${dir}.generated.ts`
    : `${dir}.composition.${composition}.generated.ts`;
}

/** Where composition `composition`'s `<dir>` registry lives — see
 *  `compositionRegistryFileName` for why main resolves to the committed file. */
export function compositionRegistryPath(
  def: DiscoveredCollectedDir,
  composition: string,
): string {
  return composition === MAIN_COMPOSITION_ID
    ? collectedDirRegistryPath(def)
    : collectedDirNamedCompositionRegistryPath(def, composition);
}

/**
 * For a compiled release of `composition`: each committed registry paired with
 * the composition's filtered sibling, both absolute. `release` resolves every
 * import of a committed registry to its sibling, so whatever entrypoint reaches
 * a registry — by alias, by relative path, through any barrel — bundles the
 * composition's closure and nothing else, with no per-registry wiring at the
 * call site. Empty for the main composition, whose registries ARE the committed
 * files (`compositionRegistryFileName`).
 */
export async function compositionRegistryRedirects(
  repo: RepoFiles,
  composition: string,
): Promise<{ committed: string; filtered: string }[]> {
  if (composition === MAIN_COMPOSITION_ID) return [];
  return (await compositionFilteredRegistries(repo)).map(
    ({ def, committed }) => ({
      committed,
      filtered: collectedDirNamedCompositionRegistryPath(def, composition),
    }),
  );
}

/**
 * Every collected dir a composition gets a filtered sibling of, with its
 * committed registry's absolute path — the registries whose contents depend on
 * the composition, as opposed to the code that imports them.
 */
export async function compositionFilteredRegistries(
  repo: RepoFiles,
): Promise<{ def: DiscoveredCollectedDir; committed: string }[]> {
  return (await discoverCollectedDirsIn(repo))
    .filter((def) => COMPOSITION_RUNTIME_DIRS.has(def.dir))
    .map((def) => ({ def, committed: collectedDirRegistryPath(def) }));
}

/** Parse `<dir>.composition.<name>.generated.ts` into its parts, else null. */
export function parseNamedCompositionRegistryFileName(
  fileName: string,
): { dir: string; name: string } | null {
  const m =
    /^([a-z]+)\.composition\.([a-z0-9][a-z0-9-]{0,62})\.generated\.ts$/.exec(
      fileName,
    );
  if (m === null) return null;
  return { dir: m[1]!, name: m[2]! };
}

// ── Where a composition's build writes ──────────────────────────────
//
// ONE list of locations, read by everything that touches these files: the
// writer (`generateCompositionRegistry`), the listing (reclaim, the resident-
// composition replan), and the `.gitignore` patterns that hide them
// (`compositionOutputIgnorePatterns`, held equal to `.gitignore` by this
// plugin's `composition-outputs-ignored` check).
//
// That last equality is what keeps a RETIRED output from lingering. `.gitignore`
// hides exactly the locations a build writes today, nothing broader, so when a
// writer stops writing somewhere its pattern leaves `.gitignore` with it and
// whatever older builds left there becomes a file git SEES. A per-composition
// output git sees is therefore dead by construction (`deadCompositionOutputs`),
// and every pass root that would otherwise read or commit it — `build` before
// its first writer, `push` before its commit — deletes it. A broad
// `*.composition.*.generated.ts` pattern hid such files forever: the post-web
// manifests' `apps.composition.<id>` / `theme-declarations.composition.<id>`
// copies outlived their writer in every checkout that had built a composition.

/** One place a composition's build writes a file, whatever the composition. */
export interface CompositionOutputLocation {
  /** The folder the file is written to. */
  folder: AppPath;
  /** The file name's stem: the collected dir's `dir`, `index` for the backend entry. */
  stem: string;
  /**
   * What `listNamedCompositionRegistries` calls it: the collected dir, or
   * `bin` (the folder it sits in) for the backend entry.
   */
  listedAs: string;
  /** The collected dir whose filtered registry this is; null for the backend entry. */
  def: DiscoveredCollectedDir | null;
}

/**
 * Every location a non-main composition's build writes: each filtered
 * registry (`COMPOSITION_RUNTIME_DIRS`, in its collected dir's `core/`) and
 * the composition's backend entry (`bin/index.composition.<id>.generated.ts`,
 * written last by the writer so it never names a registry not yet on disk).
 */
export async function compositionOutputLocations(
  repo: RepoFiles,
): Promise<CompositionOutputLocation[]> {
  const registries = (await compositionFilteredRegistries(repo)).map(
    ({ def }): CompositionOutputLocation => ({
      folder: joinAppPath(def.ownerDir, "core"),
      stem: def.dir,
      listedAs: def.dir,
      def,
    }),
  );
  return [
    ...registries,
    {
      folder: joinAppPath(repo.root, SERVER_CORE_RELATIVE, "bin"),
      stem: "index",
      listedAs: "bin",
      def: null,
    },
  ];
}

/** The file `composition`'s build writes at `location`. */
export function compositionOutputPath(
  location: CompositionOutputLocation,
  composition: string,
): AppPath {
  assertCompositionName(composition);
  if (composition === MAIN_COMPOSITION_ID) {
    // Main's registries and entry are the committed files, never a sibling.
    throw new Error(
      `compositionOutputPath: the main composition writes no per-composition file (${location.stem})`,
    );
  }
  return joinAppPath(
    location.folder,
    compositionRegistryFileName(location.stem, composition),
  );
}

/**
 * The `.gitignore` lines that hide every composition's outputs and nothing
 * else: one anchored pattern per location, `*` standing for the id (a `*`
 * never crosses a `/`). `.gitignore` holds exactly these — the
 * `composition-outputs-ignored` check — so a retired location is visible to git.
 */
export async function compositionOutputIgnorePatterns(
  repo: RepoFiles,
): Promise<string[]> {
  return (await compositionOutputLocations(repo))
    .map(
      (loc) =>
        `/${relative(repo.root, loc.folder)}/${loc.stem}.composition.*.generated.ts`,
    )
    .sort();
}

/**
 * Whether a file name is spelled like a per-composition output — any stem,
 * any composition id, or none (the retired singleton
 * `<dir>.composition.generated.ts`).
 */
export function isCompositionOutputName(fileName: string): boolean {
  return /^[^/]+\.composition\.(?:[^/]+\.)?generated\.ts$/.test(fileName);
}

/**
 * The per-composition outputs in `repo`'s file set (tracked +
 * untracked-not-ignored), repo-relative. Every live one is gitignored (the
 * `composition-outputs-ignored` check), so each of these is one no build writes any more
 * — left by an older build, at a location `.gitignore` stopped hiding — and
 * nothing reads it. The pass roots delete them (`removeDeadCompositionOutputs`).
 */
export function deadCompositionOutputs(repo: RepoFiles): string[] {
  return repo.all().filter((p) => isCompositionOutputName(basename(p)));
}

/**
 * Delete every UNTRACKED dead per-composition output in `repo`'s file set
 * (`deadCompositionOutputs`) and answer the repo-relative paths deleted, for
 * the caller to log. A tracked one is left alone — it is someone's commit, and
 * the `composition-outputs-ignored` check fails on it by name. Called by `build` before
 * its first writer, by `push` before its commit and by the post-rebase
 * normalize before its amend, so a dead copy is neither read as source nor
 * committed.
 */
export async function removeDeadCompositionOutputs(
  repo: RepoFiles,
): Promise<string[]> {
  const dead = deadCompositionOutputs(repo);
  if (dead.length === 0) return [];
  // `??` in `git status` is untracked-not-ignored: exactly the leftovers.
  const status = await spawnExpectOk(
    [
      "git",
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      ...dead.map((p) => `:(literal)${p}`),
    ],
    { cwd: repo.root, timeoutMs: GIT_TIMEOUT_MS },
  );
  const untracked = status.stdout
    .split("\0")
    .filter((rec) => rec.startsWith("?? "))
    .map((rec) => rec.slice(3));
  for (const rel of untracked) {
    await rm(join(repo.root, rel), { force: true });
  }
  return untracked;
}

// Wedge-breaker for one pathspec-scoped status: far above any real duration.
const GIT_TIMEOUT_MS = 60_000;

/**
 * Every per-name composition registry currently on disk, and every
 * composition's backend entry (`bin/index.composition.<name>.generated.ts`) —
 * read from the locations a build writes (`compositionOutputLocations`), so
 * the listing and the writer cannot disagree on where to look. Reclaim's
 * input (delete the files of a composition no longer served from here).
 *
 * The per-name files themselves are GITIGNORED, so no file set holds them:
 * reading the (at most six) owning folders is the only way to see them.
 */
export async function listNamedCompositionRegistries(
  repo: RepoFiles,
): Promise<Array<{ dir: string; name: string; file: string }>> {
  const out: Array<{ dir: string; name: string; file: string }> = [];
  for (const loc of await compositionOutputLocations(repo)) {
    let entries;
    try {
      entries = await readdir(loc.folder, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const parsed = parseNamedCompositionRegistryFileName(entry.name);
      if (parsed === null || parsed.dir !== loc.stem) continue;
      out.push({
        dir: loc.listedAs,
        name: parsed.name,
        file: join(loc.folder, entry.name),
      });
    }
  }
  return out;
}
