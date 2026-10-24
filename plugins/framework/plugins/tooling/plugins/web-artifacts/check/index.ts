// Contributed checks guarding the per-plugin web-artifact composition.
//
// BOTH are `scope: "deploy"`: their subject is the local deployment `build`
// produces — this checkout's served dist (`~/.singularity/worktrees/<name>/web`)
// and the `~/.singularity/cache/web-artifacts` store, both outside any repo — not the
// tree. So neither is in the push payload,
// and `push` (which asks for `--scope tree`) does not run them; `build`, a
// standalone `./equin check`, and main's post-push auto-build do. Each
// therefore owes a `cacheSignature()` covering that deploy state, since the
// runner's tree hash does not reach it — see `Check.scope`.
//
//   web-artifacts:map-in-sync — the deployed dist's import map is the one the
//   CURRENT tree composes. Every dist is an artifact dist since the monolithic
//   vite build was removed, so a MISSING `.web-artifacts.json` marker is now a
//   real failure (nothing deployed, or a pre-artifacts dist), not the old
//   "monolith ⇒ nothing to verify" pass, and a checkout registered to no
//   namespace at all fails before that, with no path to name. A stale map fails
//   with the `./equin build` fix. Skips (uncached) inside a `./equin build`
//   process, where the dist under inspection is the one that very build is about
//   to replace — standalone runs verify for real.
//
//   web-artifacts:no-vendored-state-inlined — no plugin artifact in the current
//   fleet's expected set bundles modules of an npm package outside the inline
//   allowlist. Vendoring is what guarantees one module instance per package;
//   an inlined copy of a stateful package (React context registries, scheduler,
//   …) is the silent dual-instance bug class. Verdicts are cached per artifact
//   dir (content-addressed ⇒ immutable) so the sourcemap scan is one-time.
//
// `scope` and `isBuildInProgress()` are ORTHOGONAL — neither subsumes the other,
// and deleting either as redundant reopens a real hole:
//   - `isBuildInProgress()` (run-context) answers "a build races its own
//     publish": a build MUST run these checks — it IS the deploy — but at check
//     time its dist is still the previous one, so the comparison is skipped for
//     that one process.
//   - `scope` answers "push is not a deploy": push never inspects the dist at
//     all, whatever process is or isn't building.

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTimeSlicer } from "@plugins/packages/plugins/macrotask-yield/core";
import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { isBuildInProgress } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  type CheckoutDeploy,
  resolveCheckoutDeploy,
  worktreeArtifacts,
} from "@plugins/infra/plugins/paths/core";
import { INLINE_PACKAGES } from "../core/constants";
import { diffImportMaps } from "../core/import-map";
import {
  computeExpectedComposition,
  planExpectedFleet,
} from "../core/internal/expected";
import {
  artifactStorePath,
  hasArtifact,
  WEB_ARTIFACTS_DIR,
  WEB_ARTIFACTS_STORE_DIR,
} from "../core/internal/store";
import {
  extractEntryScriptSrc,
  extractImportMap,
  offendingPackages,
  packagesInSourcemapSources,
} from "./scan";

const MARKER_NAME = ".web-artifacts.json";
const BUILD_HINT =
  "Run `./equin build` to recompose the dist from the current tree.";

/**
 * Which dist this checkout deploys, or the fact that it deploys none.
 *
 * A checkout with no deploy has no dist, and there is no honest path to hand
 * back for it — so the absence is an arm of the result rather than a directory
 * name invented on its behalf. Every caller below has to say what it does about
 * that, which is the point: the previous spelling had one, and it silently gave
 * all three of them somebody else's.
 */
type DeployedDist =
  | { kind: "dist"; dir: string }
  /** What this checkout DOES serve, so a refusal can name it. */
  | { kind: "none"; others: readonly CheckoutDeploy[] };

/**
 * The dist THIS CHECKOUT deploys, read out of the registry the deploy wrote.
 *
 * The namespace is not derivable from a name, and both names within reach get it
 * wrong. `runtimeNamespace()` answers a question about a different process —
 * which namespace is *this backend* the server for — and a check runs in a CLI
 * process, which declares none and would simply throw. The checkout's
 * own basename reads safer and is not, because a `--composition` build publishes
 * `<composition>.<checkout>` and never the checkout's own app — so the basename
 * names a directory nothing ever deployed to, and `asNamespace` on it launders
 * away the very brand check that would have said so.
 *
 * `resolveCheckoutDeploy` asks the third question instead — which deploy did
 * this checkout *publish* — by reading back the `spec.json` each deploy wrote
 * naming the checkout behind it. It is synchronous and git-free, so
 * `cacheSignature()` can still call it.
 */
function deployedDist(root: string): DeployedDist {
  const resolved = resolveCheckoutDeploy(root);
  return resolved.kind === "resolved"
    ? {
        kind: "dist",
        dir: worktreeArtifacts.webDist(resolved.deploy.namespace),
      }
    : { kind: "none", others: resolved.others };
}

function readIfExists(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return null;
  }
}

/** The dist's recorded minify flag (Phase-1 markers lack it → the default, true). */
function markerMinify(markerRaw: string): boolean {
  const parsed = JSON.parse(markerRaw) as { minify?: boolean };
  return typeof parsed.minify === "boolean" ? parsed.minify : true;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function storeMtime(): string {
  try {
    return String(statSync(WEB_ARTIFACTS_STORE_DIR).mtimeMs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return "no-store";
  }
}

/**
 * The tail of the no-deploy message: what this checkout serves *instead*.
 *
 * "Nothing at all" and "everything except your own app" have different fixes and
 * read identically without this. A checkout built only with `--composition` is
 * registered to `<composition>.<checkout>` and to nothing else, so the reader
 * would otherwise be told to run a build they demonstrably already ran.
 */
function serves(others: readonly CheckoutDeploy[]): string {
  if (others.length === 0) return "";
  const list = others
    .map((d) => `${d.namespace} (composition "${d.composition}")`)
    .join(", ");
  return (
    ` It is registered to ${list} — a \`--composition\` build publishes only that ` +
    `composition's namespace, never the checkout's own app.`
  );
}

function truncatedList(items: readonly string[], max = 15): string {
  const shown = items.slice(0, max).map((i) => `  ${i}`);
  if (items.length > max) shown.push(`  … and ${items.length - max} more`);
  return shown.join("\n");
}

const mapInSync: Check = {
  id: "web-artifacts:map-in-sync",
  description:
    "the deployed dist's import map matches the composition the current tree produces",
  scope: "deploy",
  async cacheSignature(): Promise<string | null> {
    // Never cache the build-time skip: a cached "pass" recorded while the check
    // didn't actually look would mask a stale dist on the next run that does.
    if (isBuildInProgress()) return null;
    // The memoized async root, not a `spawnSync` of git: a blocking spawn here
    // held the check runner's shared thread for ~1 s under load.
    const dist = deployedDist(await getWorktreeRoot());
    // No deploy ⇒ a real failure below, and for the same reason as a missing
    // marker: the fix is a build, which registers a namespace without moving the
    // tree hash the runner keys on, so a cached verdict would outlive it.
    if (dist.kind === "none") return null;
    const marker = readIfExists(join(dist.dir, MARKER_NAME));
    // No marker ⇒ a real failure below. Never cache that verdict: the fix is a
    // build, which changes the dist but not the tree hash the runner keys on.
    if (marker === null) return null;
    const html = readIfExists(join(dist.dir, "index.html")) ?? "";
    // The verdict depends on the deployed dist AND on which artifacts the store
    // holds (the expected map is recomputed through store metas) — fold both in.
    return sha256(`${marker}\n${html}\n${storeMtime()}`);
  },
  async run(): Promise<CheckResult> {
    // See run-context.ts: during `./equin build` the checks race the
    // frontend build, so the deployed dist is by definition the one this build
    // replaces — comparing it against the current tree would fail every build
    // that changes source. Push/standalone runs verify for real.
    if (isBuildInProgress()) return { ok: true };

    const root = await getWorktreeRoot();
    const dist = deployedDist(root);
    // Nothing is registered to this checkout's backend, so there is no dist —
    // not an empty one at a known path, none at all. Naming a path here would
    // be inventing the directory a build WOULD have written, which is the whole
    // defect this resolution replaced.
    if (dist.kind === "none") {
      return {
        ok: false,
        message:
          `no deploy is registered to this checkout, so there is no dist to compare against — ` +
          `\`./equin build\` has never published one from here.` +
          serves(dist.others),
        hint: BUILD_HINT,
      };
    }

    const markerRaw = readIfExists(join(dist.dir, MARKER_NAME));
    // The marker is written by every compose. Its absence used to mean "a
    // monolith dist — nothing to verify"; with the monolith gone it can only
    // mean nothing is deployed at this path, or what is deployed predates the
    // artifacts pipeline. Either way there is no composition to compare, which
    // is a failure, not a pass.
    if (markerRaw === null) {
      return {
        ok: false,
        message:
          `no artifact dist deployed at ${dist.dir} (missing ${MARKER_NAME}) — every dist is ` +
          `composed by the web-artifacts pipeline, so this checkout has either never been ` +
          `built or carries a pre-artifacts dist.`,
        hint: BUILD_HINT,
      };
    }

    const html = readIfExists(join(dist.dir, "index.html"));
    if (html === null) {
      return {
        ok: false,
        message: `artifact-mode dist marker present but ${join(dist.dir, "index.html")} is missing`,
        hint: BUILD_HINT,
      };
    }
    const deployed = extractImportMap(html);
    if (deployed === null) {
      return {
        ok: false,
        message: "artifact-mode dist's index.html carries no inline import map",
        hint: BUILD_HINT,
      };
    }

    const expected = await computeExpectedComposition({
      root,
      minify: markerMinify(markerRaw),
    });
    if (expected.kind === "missing-artifacts") {
      return {
        ok: false,
        message:
          `the deployed dist predates the current tree: ${expected.missing.length} artifact(s) the ` +
          `current tree composes are absent from the store:\n${truncatedList(expected.missing)}`,
        hint: BUILD_HINT,
      };
    }

    const diff = diffImportMaps(deployed, expected.imports);
    const problems: string[] = [];
    if (diff.changed.length > 0) {
      problems.push(
        `${diff.changed.length} specifier(s) point at a stale artifact:\n` +
          truncatedList(
            diff.changed.map(
              (c) => `${c.specifier}: ${c.deployed} → ${c.expected}`,
            ),
          ),
      );
    }
    if (diff.missing.length > 0) {
      problems.push(
        `${diff.missing.length} expected specifier(s) missing from the deployed map:\n` +
          truncatedList(diff.missing),
      );
    }
    if (diff.extra.length > 0) {
      problems.push(
        `${diff.extra.length} deployed specifier(s) the current tree no longer composes:\n` +
          truncatedList(diff.extra),
      );
    }
    const deployedEntry = extractEntryScriptSrc(html);
    if (deployedEntry !== expected.entryUrl) {
      problems.push(
        `entry script: deployed ${deployedEntry ?? "<none>"}, expected ${expected.entryUrl}`,
      );
    }
    if (problems.length > 0) {
      return {
        ok: false,
        message: `deployed import map is out of sync with the current tree:\n${problems.join("\n")}`,
        hint: BUILD_HINT,
      };
    }
    return { ok: true };
  },
};

// ── no-vendored-state-inlined ───────────────────────────────────────

const SCANNER_VERSION = 1;
const SCAN_CACHE_FILE = join(WEB_ARTIFACTS_DIR, "vendored-scan.json");

interface VendoredScanCache {
  version: number;
  /** artifact dirName → ALL node_modules packages found in its sourcemap.
   * Unfiltered by the allowlist, so an allowlist edit re-filters without
   * re-scanning; immutable per dirName (content-addressed artifacts). */
  inlined: Record<string, string[]>;
}

function loadScanCache(): VendoredScanCache {
  const raw = readIfExists(SCAN_CACHE_FILE);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as VendoredScanCache;
      if (
        parsed.version === SCANNER_VERSION &&
        typeof parsed.inlined === "object"
      ) {
        return parsed;
      }
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
  }
  return { version: SCANNER_VERSION, inlined: {} };
}

function saveScanCache(cache: VendoredScanCache): void {
  // Keep only verdicts whose artifact still exists — bounds the file to the
  // live store. Atomic write (concurrent check runs: last writer wins; verdicts
  // are immutable, a lost entry merely re-scans).
  const inlined: Record<string, string[]> = {};
  for (const [dirName, pkgs] of Object.entries(cache.inlined)) {
    if (hasArtifact(dirName)) inlined[dirName] = pkgs;
  }
  const tmp = `${SCAN_CACHE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: SCANNER_VERSION, inlined }));
  renameSync(tmp, SCAN_CACHE_FILE);
}

/**
 * Scan one store artifact's sourcemap for inlined node_modules packages. The
 * map is read without blocking: a build that rebuilt many artifacts leaves
 * many multi-MB maps to scan in one pass, on the check runner's shared thread.
 */
async function scanArtifact(dirName: string): Promise<string[]> {
  const mapFile = join(artifactStorePath(dirName), "index.js.map");
  const raw = await readMapIfPresent(mapFile);
  if (raw === null) {
    // The builder emits sourcemaps unconditionally — a missing map means the
    // scan has no signal, which must be loud, not a silent pass.
    throw new Error(
      `artifact ${dirName} has no index.js.map — cannot verify inlined modules`,
    );
  }
  // Fast path: no `node_modules/` substring anywhere ⇒ no npm module inlined
  // (spares the JSON.parse of multi-MB maps for the overwhelmingly common case).
  if (!raw.includes("node_modules/")) return [];
  const parsed = JSON.parse(raw) as { sources?: string[] };
  return packagesInSourcemapSources(parsed.sources ?? []);
}

/** A sourcemap's text, or null when the artifact has none. */
async function readMapIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

const noVendoredStateInlined: Check = {
  id: "web-artifacts:no-vendored-state-inlined",
  description:
    "no web artifact in the current fleet bundles modules of an npm package outside the inline allowlist (the module-identity / dual-instance guard)",
  scope: "deploy",
  cacheSignature(): string {
    // The verdict is a function of the tree (expected fleet) — covered by the
    // runner's tree hash — plus which artifacts the store holds.
    return storeMtime();
  },
  async run(): Promise<CheckResult> {
    if (!existsSync(WEB_ARTIFACTS_STORE_DIR)) return { ok: true }; // nothing composed yet

    const root = await getWorktreeRoot();
    // The marker is read for ONE field — how the deployed dist was minified — so
    // that the fleet planned here matches the artifacts the store actually
    // holds. No deploy means no marker to read, which lands on the same default
    // as a Phase-1 marker that never carried the field: minified. It is not a
    // failure here — this check's subject is the CONTENT of the artifacts in the
    // store, which exist and are worth scanning whether or not a dist was ever
    // composed from them. Staleness is map-in-sync's job, and it refuses above.
    const dist = deployedDist(root);
    const markerRaw =
      dist.kind === "none" ? null : readIfExists(join(dist.dir, MARKER_NAME));
    const minify = markerRaw === null ? true : markerMinify(markerRaw);

    // The expected fleet for the current tree; artifacts not (yet) in the store
    // are skipped — staleness is map-in-sync's job, this check verifies the
    // content of what exists. The registry artifact is excluded by construction
    // (type-stripped transform, never bundles).
    const fleet = await planExpectedFleet({ root, minify });
    const present = fleet.targets.filter((t) => hasArtifact(t.dirName));
    if (present.length === 0) return { ok: true }; // nothing composed yet

    const cache = loadScanCache();
    let scanned = 0;
    const offenders: string[] = [];
    // Each uncached map is a `JSON.parse` of up to several MB: pause between
    // artifacts so a freshly rebuilt fleet is not scanned as one block.
    const slice = createTimeSlicer();
    for (const t of present) {
      let inlined = cache.inlined[t.dirName];
      if (inlined === undefined) {
        await slice();
        inlined = await scanArtifact(t.dirName);
        cache.inlined[t.dirName] = inlined;
        scanned++;
      }
      const offending = offendingPackages(inlined, INLINE_PACKAGES);
      if (offending.length > 0) {
        offenders.push(`${t.dirName}: ${offending.join(", ")}`);
      }
    }
    if (scanned > 0) saveScanCache(cache);

    if (offenders.length > 0) {
      return {
        ok: false,
        message:
          `${offenders.length} artifact(s) bundle npm modules outside the inline allowlist ` +
          `(INLINE_PACKAGES in web-artifacts/core/constants.ts) — each inlined copy is a second ` +
          `module instance next to the vendored one (the React-context dual-instance bug class):\n` +
          truncatedList(offenders),
        hint:
          "Fix the externals rule regression (web-artifacts/core/externals.ts) — or, ONLY for a " +
          "provably stateless package, extend INLINE_PACKAGES. Then bump BUILDER_VERSION and rebuild.",
      };
    }
    return { ok: true };
  },
};

export default [mapInSync, noVendoredStateInlined];
