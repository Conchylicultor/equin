import { createHash } from "node:crypto";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineHostPool } from "@plugins/infra/plugins/host/plugins/host-admission/server";
import { HOST_POOLS } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import {
  getWorktreeRoot,
  spawnCaptured,
} from "@plugins/infra/plugins/spawn/core";
import type {
  Check,
  CheckContext,
  CheckResult,
  RepoFiles,
} from "@plugins/framework/plugins/tooling/core";
import { ensureDepViaCli } from "@plugins/infra/plugins/deps/deps";
import { chromium } from "@plugins/infra/plugins/safe-fetch/plugins/browser-fetch/deps";
import { layoutLabDir } from "../data-dirs";
import { classifyFailure } from "./classify";

// The contributed `layout-geometry` check. It gates the layout-primitive geometry
// invariants (no track collision / no overlap / truncation-onset) by shelling out
// to the bun:test geometry suite — but only when the inputs the suite depends on
// have changed. Steady-state cost is ZERO browser launches via a sidecar marker
// keyed on a tree hash of the css subtree, app.css, and every exhibit
// contributor's whole plugin subtree.

// The seed paths whose content is the suite's real input, expressed as a
// predicate over the run's own file set (`ctx.repo()`) instead of git
// pathspecs: every css primitive subtree, the ui-kit stylesheet, and —
// repo-wide, not just under css/plugins — every exhibit contributor's
// `exhibits/` path (see `exhibitContributorRoots` below for why "repo-wide"
// matters: `exhibits/` is a collected dir, so a contributor need not be a css
// primitive at all).
//
// Every `exhibits/` folder counts, app exhibits included: the suite loads the
// whole catalog (strict — one broken contribution fails the load), so any
// exhibit edit can change its verdict, and a contributor's plugin subtree is
// cheap to hash next to a Chromium launch.
const CSS_PLUGINS_PREFIX = "plugins/primitives/plugins/css/plugins/";
// The catalog's own core: the loader and the generated registry the suite
// reads every exhibit through.
const CATALOG_CORE_PREFIX = "plugins/plugin-meta/plugins/exhibits/core/";
// A plugin's own `exhibits/` leaf folder — `plugins/<a>(/plugins/<b>)*/exhibits/`
// — and nothing else named `exhibits` (the catalog plugin itself is
// `plugin-meta/plugins/exhibits`, a child plugin, not a leaf folder). Capture
// group 1 is the contributor's plugin root.
const EXHIBITS_FOLDER_RE = /^(plugins\/[^/]+(?:\/plugins\/[^/]+)*)\/exhibits\//;
const APP_CSS_PATH =
  "plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css";

/**
 * `RepoFiles.all()` is the exact tracked+untracked-not-ignored universe
 * `git ls-files` (+ `--others --exclude-standard`) covers, so filtering it
 * this way matches the old pathspec globs file-for-file: none of the three
 * used a git wildmatch feature (char classes, negation) a prefix/substring
 * test can't express.
 */
function isSeedPath(path: string): boolean {
  return (
    path.startsWith(CSS_PLUGINS_PREFIX) ||
    path === APP_CSS_PATH ||
    path.startsWith(CATALOG_CORE_PREFIX) ||
    EXHIBITS_FOLDER_RE.test(path)
  );
}

/**
 * The plugin roots of the exhibit contributors, derived from the exhibit paths
 * themselves — `<root>/exhibits/<anything>` ⇒ `<root>`.
 *
 * An exhibit is not the thing under test. It is a few lines of JSX; what it
 * measures is the PRIMITIVE it renders. Hashing `adaptive-bar/exhibits/**` and
 * not `adaptive-bar/web/**` therefore covered the cheap half and missed the
 * expensive one: an edit to the primitive changed every box the gate measures
 * and left the marker valid, so the check answered `ok (cached)` about geometry
 * it had never seen. That is how a primitive whose guard took the Layout Lab
 * down shipped past a green gate.
 *
 * Derived rather than listed, so a plugin that starts contributing exhibits
 * tomorrow is covered the day it does — with no glob to remember to add, which
 * is the maintenance failure that opened the hole the first time.
 */
function exhibitContributorRoots(exhibitPaths: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const rel of exhibitPaths) {
    const root = EXHIBITS_FOLDER_RE.exec(rel)?.[1];
    if (root !== undefined) roots.add(root);
  }
  return [...roots].sort();
}

const SUITE_REL =
  "plugins/primitives/plugins/css/plugins/layout-harness/web/internal/layout-geometry.test.ts";

// Host-wide single-holder gate for the browser-based suite. The suite spawns a
// Vite build + a headless Chromium; concurrent worktree builds would otherwise
// each launch Chromium at the same moment, thrashing CPU until Playwright's
// launch budget is exhausted — the headless-launch-timeout flake. size 1 ⇒ at
// most one suite runs across ALL worktrees; combined with the post-acquire
// marker re-check it also collapses the same-sig thundering herd (the first
// build runs + writes the marker, the rest skip the launch). flock-backed, so it
// auto-releases on crash.
//
// The pool is a CARDINALITY cap on concurrent Chromium launches and nothing
// more — it claims no CPU. The CPU this run costs is spent separately, and once,
// as a `ctx.grant` unit around the launch (below). The two are orthogonal
// guarantees: the pool makes the run mutually exclusive host-wide, the grant
// makes it accounted against the invoking build's budget.
//
// `size` is read from the pool table rather than re-spelled here, so the table
// and this call site cannot drift — the same pattern as `fork-gate`,
// `mutate-gate`, `host-read-pool` and `browser-fetch`.
const browserPool = defineHostPool({
  id: "layout-geometry",
  size: HOST_POOLS["layout-geometry"].size,
  // `inherit`: decided from measured waits (op log `waits[]` by kind).
  holder: "inherit",
});

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// Two passes, because the second root set is not knowable up front: filter the
// seed from the run's already-loaded file set, read the exhibit contributors
// OUT of what came back, then pull their whole plugin subtrees too via
// `repo.under()`. Pure lookups over `RepoFiles` — no git spawn, no I/O of its
// own — so this can run on every check run for free.
function listFiles(repo: RepoFiles): string[] {
  const seed = repo.all().filter(isSeedPath);
  const set = new Set(seed);
  for (const root of exhibitContributorRoots(seed)) {
    for (const rel of repo.under(root)) set.add(rel);
  }
  return [...set].sort();
}

async function computeSig(repo: RepoFiles): Promise<string> {
  const files = listFiles(repo);
  // Read concurrently (repo.read() is already bounded/memoized per run) but
  // hash in the SORTED order above, so the digest never depends on read
  // completion order.
  const contents = await Promise.all(files.map((rel) => repo.read(rel)));
  const h = createHash("sha256");
  for (let i = 0; i < files.length; i++) {
    h.update(files[i]!);
    h.update("\0");
    // A path the run's file set no longer has (vanished, or unreadable)
    // contributes nothing — same as the old ENOENT-swallow.
    if (contents[i] !== null) h.update(contents[i]!);
    h.update("\0");
  }
  return h.digest("hex");
}

// The sidecar pass markers live in the `cache/layout-lab` data dir this plugin
// declares — host-global on purpose, so a peer worktree that already ran the
// suite for these exact bytes counts as a real pass.
function markerFile(sig: string): string {
  return layoutLabDir.file(`${sig}.pass`);
}

const check: Check = {
  id: "layout-geometry",
  description:
    "layout primitives hold their geometry invariants (no track collision / overlap regressions)",
  // No `cacheSignature()`: this check is `scope: "tree"` (the default), and the
  // runner's own tree hash — tracked + untracked-not-ignored — already covers
  // the exact universe `computeSig` reads via `ctx.repo()` below. A signature
  // here could never separate two states the tree hash doesn't; see
  // checks/CLAUDE.md, "A scope: 'tree' verdict must not depend on the process
  // that produced it."
  async run(ctx: CheckContext): Promise<CheckResult> {
    const root = await getWorktreeRoot();
    const repo = await ctx.repo();
    const sig = await computeSig(repo);

    // Steady state: an unchanged css subtree ⇒ the sidecar marker exists ⇒ return
    // OK WITHOUT launching Chromium, regardless of unrelated edits elsewhere. This
    // fast path stays UN-gated, so the zero-launch steady state never queues.
    layoutLabDir.ensure();
    if (existsSync(markerFile(sig))) return { ok: true };

    // Chromium is an on-demand dependency. Install it (a no-op once it is)
    // BEFORE taking the pool: in a `./singularity deps install` child, which
    // spends a unit of THIS op's grant (passed down) rather than queueing
    // host-wide behind it — on a one-unit host that queue waited on its own
    // parent until the install timed out. The suite's measurer then finds it
    // installed (see `web/internal/measure-page.ts`).
    try {
      await ctx.grant.run(() =>
        ensureDepViaCli(chromium, { stdio: "capture", grant: ctx.grant }),
      );
    } catch (err) {
      return {
        ok: false,
        message: `Chromium, which the layout geometry suite runs in, could not be installed: ${(err as Error).message}`,
        hint: "Run `./singularity deps install chromium` to see the install fail in full (its log is also in Settings → Dependencies), then re-run.",
      };
    }

    // Marker absent ⇒ the suite must actually launch Chromium. Spend a grant unit
    // (a cpu-holder that then waits on the size-1 pool — acyclic, the pool holder
    // waits for nothing) around the host-wide-serialized launch. Re-check the
    // marker after acquiring: a peer build with the same sig may have just run the
    // suite and written it, in which case we skip the launch (double-checked).
    return ctx.grant.run(() =>
      browserPool.run(async () => {
        if (existsSync(markerFile(sig))) return { ok: true };

        // `--timeout 120000`: this suite's `beforeAll` runs a Vite build + a cold
        // headless Chromium launch + page load, which routinely exceeds bun:test's
        // default 5s per-hook budget under any real load — the dominant cause of the
        // historical "hook timed out / launch timeout" flake. The flag raises the
        // default for every hook AND test in the suite (the measures themselves stay
        // sub-second), so a slow-but-healthy setup never trips the gate.
        const { stdout, stderr, exitCode } = await spawnCaptured(
          ["bun", "test", "--timeout", "120000", resolve(root, SUITE_REL)],
          // Deliberately an order of magnitude above the suite's OWN 120 s
          // per-hook/test budget set on the line above: that inner budget is the
          // real bound on healthy-but-slow work, and this outer one exists only
          // for the case the inner one cannot cover — a `bun test` process that
          // is wedged rather than slow, and so never gets round to enforcing it.
          { cwd: root, timeoutMs: 900_000 },
        );

        if (exitCode === 0) {
          // Record the pass atomically (write-temp + rename on the same fs).
          const file = markerFile(sig);
          const tmp = layoutLabDir.file(`.${sha256(file).slice(0, 12)}.tmp`);
          writeFileSync(tmp, JSON.stringify({ sig, recordedAt: Date.now() }));
          renameSync(tmp, file);
          return { ok: true };
        }

        // Classify on the FULL, untruncated transcript — a real assertion/oracle
        // failure printed early in a long, timeout-laced run must NOT be trimmed
        // away by the tail and misread as environmental. Only the human-facing
        // `message` below uses the tail.
        const fullOutput = `${stdout}\n${stderr}`;

        // bun:test prints results to stderr; include a tail of both streams.
        const tail = (s: string, n = 60): string =>
          s.trim().split("\n").slice(-n).join("\n");
        const combined = [tail(stderr), tail(stdout)]
          .filter(Boolean)
          .join("\n");

        if (classifyFailure(fullOutput) === "inconclusive") {
          // Environmental: the suite never reached a verdict (cold Vite/Chromium
          // under host load timed out), NOT a geometry regression. Non-fatal and
          // NOT cached — the pass marker is deliberately not written, so the next
          // build re-launches the suite and re-verifies the invariants.
          return {
            ok: false,
            inconclusive: true,
            message: `layout geometry suite timed out (environmental — cold Vite/Chromium under host load, not a geometry regression; exit ${exitCode}):\n${combined}`,
            hint: `Re-run \`bun test --timeout 120000 ${SUITE_REL}\` on a quieter host to re-verify; the check retries automatically on the next build.`,
          };
        }

        return {
          ok: false,
          message: `layout geometry suite failed (exit ${exitCode}):\n${combined}`,
          hint: `A layout primitive geometry invariant regressed — run \`bun test --timeout 120000 ${SUITE_REL}\` to see which exhibit/slot collided.`,
        };
      }),
    );
  },
};

export default check;
