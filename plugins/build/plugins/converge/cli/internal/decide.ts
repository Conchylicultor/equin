import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { asPath, asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { readEffectiveConfigFromDiskSync } from "@plugins/config_v2/plugins/disk-read/core";
import { configDir } from "@plugins/config_v2/data-dirs";
import {
  MAIN_COMPOSITION_ID,
  namespaceFor,
  type CheckoutRef,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import {
  isServableCompositionId,
  type CompositionManifestItem,
} from "@plugins/plugin-meta/plugins/composition/core";
import { loadCompositionMarker } from "@plugins/infra/plugins/worktree/server";
import {
  MAX_NO_VERDICT_ATTEMPTS,
  wantsBuild,
  type AutoBuildDecision,
  type BuildAttempt,
} from "@plugins/build/plugins/deployment/core";
import {
  buildStatusOf,
  type BuildStatus,
} from "@plugins/build/plugins/build-status/core";
import { readServedDeployment } from "@plugins/build/plugins/deployment/cli";
import type {
  AttemptTarget,
  BuildRunRecorder,
} from "@plugins/build/plugins/run-ledger/cli";
import { buildConfig } from "@plugins/build/core";
import { compositionWantsRebuild } from "./composition-trigger";

/** What one convergence pass concluded, from one read of the world. */
export interface ConvergenceDecision {
  /**
   * This checkout's own app: wanted (`kind: "build"`), or why not — so the run
   * never calls a deployment converged that is not. `auto-build-off`: the
   * checkout's `autoBuild` kill switch.
   */
  main: AutoBuildDecision | { kind: "auto-build-off" };
  /** Served compositions to rebuild, in manifest order. */
  compositions: string[];
  /**
   * The wanted targets (main's own app, compositions) whose build retries an
   * attempt at the same commit that ended with no verdict (killed,
   * interrupted, superseded), each with the id of that newest attempt — what
   * lets the run tell a retry of a build it just made from a ledger that
   * lost that build's attempt.
   */
  retries: { target: string; newest: string }[];
  /** The HEAD both halves converge toward (`null`: git could not name one). */
  head: string | null;
  /**
   * The commit this checkout's served dist names — what it actually serves —
   * or why it cannot say (no dist, a dist published before the pin existed).
   */
  served: { ok: true; commit: string } | { ok: false; reason: string };
  /**
   * Whether this namespace has a `build_runs` table at all. `missing` is the
   * machine's very first build: no attempt can be recorded, so the ledger
   * cannot terminate the loop and the caller must run at most one pass.
   */
  ledger: "present" | "missing";
}

/**
 * Does this checkout want an automatic build — of its own app, of a
 * composition it serves (main only), or of neither?
 *
 * The policy is the pure `wantsBuild` (deployment/core) and
 * `compositionWantsRebuild` (next door); this binds them to durable state — git,
 * the served dist, the `build_runs` ledger, the config files on disk — and to
 * NOTHING held in a backend's memory. That is the whole point: it runs in
 * main's convergence process (`./equin build --allow-main --converge`, started
 * by the gateway), so it answers the same while main's backend is down, which
 * is exactly when it matters most (the 2026-11-08 incident: a fix sat on main
 * for eleven minutes because the only thing that could decide to build it was
 * the backend it was meant to fix).
 *
 * It answers for the checkout it is given: its own app always (any checkout's
 * deployment can be behind its HEAD), the compositions it serves only on main's
 * checkout. The gateway runs it for main alone. `autoBuild: false` is the
 * checkout's kill switch, read off disk like every other input here.
 *
 * `namespace` is the checkout's own (`actAsCheckoutNamespace`) — the served
 * dist read is that namespace's.
 */
export async function decideConvergence(i: {
  root: AppPath;
  checkout: CheckoutRef;
  namespace: Namespace;
  /** The compositions this checkout declares (its resolved config). */
  manifests: CompositionManifestItem[];
  recorder: BuildRunRecorder;
  now: Date;
}): Promise<ConvergenceDecision> {
  const deployment = await readServedDeployment(i.namespace);
  const head = deployment.target.resolved ? deployment.target.value : null;
  const web = deployment.deployable.find((c) => c.id === "web");
  const served: ConvergenceDecision["served"] =
    web === undefined
      ? { ok: false, reason: "no served dist carrier" }
      : web.commit.resolved
        ? { ok: true, commit: web.commit.value }
        : { ok: false, reason: web.commit.reason };
  let ledger: ConvergenceDecision["ledger"] = "present";
  const attempts = async (target: AttemptTarget): Promise<BuildAttempt[]> => {
    const recent = await i.recorder.recentClosedRuns(
      target,
      MAX_NO_VERDICT_ATTEMPTS,
    );
    if (recent.kind === "missing-ledger") {
      ledger = "missing";
      return [];
    }
    return recent.runs.map((run) => ({
      id: run.id,
      commit: run.commitHash,
      outcome: outcomeOf(buildStatusOf(run)),
    }));
  };

  const autoBuild = readEffectiveConfigFromDiskSync(buildConfig, {
    root: i.root,
    userConfigDir: configDir.file(i.namespace),
    hierarchyPath: BUILD_HIERARCHY_PATH,
  }).autoBuild;
  const retries: ConvergenceDecision["retries"] = [];
  // A retry's newest attempt is the no-verdict one it retries: `wantsBuild`
  // counts retries from the newest attempt down.
  const noteRetry = (
    target: string,
    want: { retry: number },
    tried: BuildAttempt[],
  ): void => {
    const newest = tried[0];
    if (want.retry > 0 && newest !== undefined)
      retries.push({ target, newest: newest.id });
  };
  // `includes`, not `only`: main's own app is built together with the
  // compositions due at the same HEAD (`convergenceBuild`), and that one row
  // is main's attempt too.
  const mainAttempts = autoBuild
    ? await attempts({ includes: MAIN_COMPOSITION_ID })
    : [];
  const main: ConvergenceDecision["main"] = autoBuild
    ? wantsBuild(deployment, mainAttempts)
    : { kind: "auto-build-off" };
  if (main.kind === "build") noteRetry(MAIN_COMPOSITION_ID, main, mainAttempts);

  const compositions: string[] = [];
  // Served compositions are main's to keep current: every checkout on the host
  // tracks refs/heads/main, so a per-checkout scope would have each one
  // rebuilding the same compositions off one push.
  const manifests = i.checkout.kind === "main" ? i.manifests : [];
  for (const item of manifests) {
    // Main's own row is inert: its namespace is this checkout's own build's.
    if (!isServableCompositionId(item.id)) continue;
    const marker = await loadCompositionMarker(
      namespaceFor(item.id, i.checkout),
    );
    // Nothing served there, so nothing to rebuild — the never-mint clause
    // `compositionWantsRebuild` states, applied early only to skip a ledger
    // read whose answer could not change the outcome.
    if (marker === null) continue;
    const tried = await attempts({ includes: item.id });
    const wants = compositionWantsRebuild({
      mode: item.serve,
      marker,
      head,
      attempts: tried,
      now: i.now,
    });
    if (wants.kind !== "build") continue;
    compositions.push(item.id);
    noteRetry(item.id, wants, tried);
  }

  return { main, compositions, retries, head, served, ledger };
}

/** Whether a closed run's status is a verdict on the code it built. */
function outcomeOf(status: BuildStatus): BuildAttempt["outcome"] {
  switch (status) {
    case "success":
      return "ok";
    case "failed":
      return "failed";
    case "killed":
    case "interrupted":
    case "superseded":
      return "no-verdict";
    case "running":
      throw new Error("[converge] a closed build_runs row read as running");
  }
}

// The build config's owning plugin — where its jsonc files live under
// `config/` and in the namespace's user config dir.
const BUILD_HIERARCHY_PATH = asPath(asPluginId("build"));
