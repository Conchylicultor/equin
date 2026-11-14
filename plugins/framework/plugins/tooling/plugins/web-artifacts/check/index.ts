// The contributed check guarding the per-plugin web-artifact composition.
//
// It is `scope: "deploy"`: its subject is the local deployment `build`
// produces — this checkout's served dist (`~/.equin/worktrees/<name>/web`)
// and the `~/.equin/cache/web-artifacts` store, both outside any repo — not the
// tree. So it is not in the push payload,
// and `push` (which asks for `--scope tree`) does not run it; `build`, a
// standalone `./equin check`, and main's post-push auto-build do. It
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
// The module-identity guard (no artifact inlines a non-allowlisted npm
// package) is not a check: it runs on each artifact as it builds
// (`core/internal/vendored-inline.ts`), so its cost is what a build built.
//
// `scope` and `isBuildInProgress()` are ORTHOGONAL — neither subsumes the other,
// and deleting either as redundant reopens a real hole:
//   - `isBuildInProgress()` (run-context) answers "a build races its own
//     publish": a build MUST run this check — it IS the deploy — but at check
//     time its dist is still the previous one, so the comparison is skipped for
//     that one process.
//   - `scope` answers "push is not a deploy": push never inspects the dist at
//     all, whatever process is or isn't building.

import { createHash } from "node:crypto";
import {
  asAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";

import { join } from "node:path";
import type {
  Check,
  CheckContext,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { isBuildInProgress } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

/** This checkout's root (a git toplevel the app resolved itself). */
async function worktreeRoot(): Promise<AppPath> {
  return asAppPath(await getWorktreeRoot());
}

import {
  type CheckoutDeploy,
  resolveCheckoutDeploySync,
  worktreeArtifacts,
} from "@plugins/infra/plugins/paths/core";
import { diffImportMaps } from "../core/import-map";
import { DIST_EDGES_FILE, type DistLink } from "../core/internal/compose";
import { DIST_LINK_FILE } from "../core/internal/link";
import {
  computeExpectedComposition,
  deployedReads,
} from "../core/internal/expected";
import type { ArtifactEdges } from "../core/internal/store";
import { extractEntryScriptSrc, extractImportMap } from "./scan";

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
 * `resolveCheckoutDeploySync` asks the third question instead — which deploy did
 * this checkout *publish* — by reading back the `spec.json` each deploy wrote
 * naming the checkout behind it. It is synchronous and git-free, so
 * `cacheSignature()` can still call it.
 */
function deployedDist(root: AppPath): DeployedDist {
  const resolved = resolveCheckoutDeploySync(root);
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
    const dist = deployedDist(await worktreeRoot());
    // No deploy ⇒ a real failure below, and for the same reason as a missing
    // marker: the fix is a build, which registers a namespace without moving the
    // tree hash the runner keys on, so a cached verdict would outlive it.
    if (dist.kind === "none") return null;
    const marker = readIfExists(join(dist.dir, MARKER_NAME));
    // No marker ⇒ a real failure below. Never cache that verdict: the fix is a
    // build, which changes the dist but not the tree hash the runner keys on.
    if (marker === null) return null;
    const html = readIfExists(join(dist.dir, "index.html")) ?? "";
    // The verdict depends on the tree (the runner's key) and the deployed dist,
    // not on the shared store: the plan reads only what the dist recorded, and
    // the store entries the dist itself serves (its vendor set, host builds,
    // snapshots — prune roots while it links them, `deployedReads`).
    return sha256(`${marker}\n${html}`);
  },
  async run(ctx: CheckContext): Promise<CheckResult> {
    // See run-context.ts: during `./equin build` the checks race the
    // frontend build, so the deployed dist is by definition the one this build
    // replaces — comparing it against the current tree would fail every build
    // that changes source. Push/standalone runs verify for real.
    if (isBuildInProgress()) return { ok: true };

    const root = await worktreeRoot();
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

    // The edges of every address the dist composed, as its compose recorded
    // them: the plan below reads only these and the served host builds, never
    // the shared store — an address this tree gives that the dist does not
    // name is one it did not compose (`deployedReads`).
    const edgesRaw = readIfExists(join(dist.dir, DIST_EDGES_FILE));
    if (edgesRaw === null) {
      return {
        ok: false,
        message:
          `the deployed dist at ${dist.dir} carries no ${DIST_EDGES_FILE} — it was composed ` +
          `before the dist recorded its artifacts' edges, so it predates the current pipeline.`,
        hint: BUILD_HINT,
      };
    }
    const recorded = new Map(
      Object.entries(JSON.parse(edgesRaw) as Record<string, ArtifactEdges>),
    );

    const expected = await computeExpectedComposition({
      repo: await ctx.repo(),
      minify: markerMinify(markerRaw),
      reads: deployedReads({ edges: recorded, imports: deployed }),
    });
    if (expected.kind === "missing-artifacts") {
      return {
        ok: false,
        message:
          `the deployed dist predates the current tree: it does not compose ${expected.missing.length} ` +
          `artifact(s) the current tree composes:\n${truncatedList(expected.missing)}`,
        hint: BUILD_HINT,
      };
    }

    const linkRaw = readIfExists(join(dist.dir, DIST_LINK_FILE));
    const link = linkRaw === null ? null : (JSON.parse(linkRaw) as DistLink);
    // The page-script entries are the link's own output: expected as the dist's
    // link recorded them, once that link is the one the tree composes.
    const expectedImports =
      link !== null && link.key === expected.linkKey
        ? { ...expected.imports, ...link.pageScripts }
        : expected.imports;
    const diff = diffImportMaps(deployed, expectedImports);
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
    // The page's modules are the link's route chunks: the dist must come from
    // the link this tree composes, and load that link's entry chunk.
    if (link === null) {
      problems.push(
        `the dist carries no ${DIST_LINK_FILE}: it was composed before route chunks`,
      );
    } else {
      if (link.key !== expected.linkKey) {
        problems.push(
          `route chunks: the dist was linked from ${link.key.slice(0, 16)}, the current tree links ${expected.linkKey.slice(0, 16)}`,
        );
      }
      const deployedEntry = extractEntryScriptSrc(html);
      if (deployedEntry !== link.entryUrl) {
        problems.push(
          `entry script: deployed ${deployedEntry ?? "<none>"}, its link's entry is ${link.entryUrl}`,
        );
      }
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

export default mapInSync;
