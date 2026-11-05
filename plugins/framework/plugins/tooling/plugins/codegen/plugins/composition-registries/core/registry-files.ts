import { readdirSync } from "@plugins/packages/plugins/timed-fs/core";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { join } from "path";
import { assertCompositionName } from "@plugins/plugin-meta/plugins/composition/core";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import { SERVER_CORE_RELATIVE } from "@plugins/infra/plugins/paths/core";
import {
  discoverCollectedDirs,
  type DiscoveredCollectedDir,
} from "@plugins/framework/plugins/tooling/plugins/collected-dir/plugins/discovery/core";

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
// a future reclaim sweep would list prewarm files like any other. (Nothing
// sweeps today — the compose-serve deactivation stage that used to was deleted
// with the serve fan-out; Phase 5 owns the replacement.)
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
export function compositionRegistryRedirects(
  root: AppPath,
  composition: string,
): { committed: string; filtered: string }[] {
  if (composition === MAIN_COMPOSITION_ID) return [];
  return compositionFilteredRegistries(root).map(({ def, committed }) => ({
    committed,
    filtered: collectedDirNamedCompositionRegistryPath(def, composition),
  }));
}

/**
 * Every collected dir a composition gets a filtered sibling of, with its
 * committed registry's absolute path — the registries whose contents depend on
 * the composition, as opposed to the code that imports them.
 */
export function compositionFilteredRegistries(
  root: AppPath,
): { def: DiscoveredCollectedDir; committed: string }[] {
  return discoverCollectedDirs(root)
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

/**
 * Every per-name composition registry currently on disk, and every
 * composition's backend entry (`bin/index.composition.<name>.generated.ts`) — the auto-serve
 * stage's sweep input (delete the entries whose name is no longer activated).
 *
 * Synchronous (callers include a synchronous program-key read), so it takes the
 * git-listed sync discovery front. The per-name registries themselves are
 * GITIGNORED, so no file set holds them: reading the (at most three) owning
 * `core/` directories is the only way to see them.
 */
export function listNamedCompositionRegistries(
  root: AppPath,
): Array<{ dir: string; name: string; file: string }> {
  const out: Array<{ dir: string; name: string; file: string }> = [];
  for (const def of discoverCollectedDirs(root)) {
    if (!COMPOSITION_RUNTIME_DIRS.has(def.dir)) continue;
    // The plugin dir of a collected dir of this checkout.
    const coreDir = joinAppPath(def.ownerDir, "core");
    let entries;
    try {
      entries = readdirSync(coreDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const parsed = parseNamedCompositionRegistryFileName(entry.name);
      if (parsed === null || parsed.dir !== def.dir) continue;
      out.push({ ...parsed, file: join(coreDir, entry.name) });
    }
  }
  // Each composition's backend entry, written with its registries
  // (`generateCompositionRegistry`) and reclaimed with them. Listed as dir
  // `bin`, the folder it sits in.
  const binDir = joinAppPath(root, SERVER_CORE_RELATIVE, "bin");
  let binEntries;
  try {
    binEntries = readdirSync(binDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return out;
  }
  for (const entry of binEntries) {
    if (!entry.isFile()) continue;
    const parsed = parseNamedCompositionRegistryFileName(entry.name);
    if (parsed === null || parsed.dir !== "index") continue;
    out.push({ dir: "bin", name: parsed.name, file: join(binDir, entry.name) });
  }
  return out;
}
