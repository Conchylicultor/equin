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
  wantsBuild,
  type BuildAttempt,
} from "@plugins/build/plugins/deployment/core";
import { readServedDeployment } from "@plugins/build/plugins/deployment/cli";
import type {
  AttemptTarget,
  BuildRunRecorder,
} from "@plugins/build/plugins/run-ledger/cli";
import { buildConfig } from "@plugins/build/core";
import { compositionWantsRebuild } from "./composition-trigger";

/** What one convergence pass concluded, from one read of the world. */
export interface ConvergenceDecision {
  /** This checkout's own app wants a build. */
  main: boolean;
  /** Served compositions to rebuild, in manifest order. */
  compositions: string[];
  /** The HEAD both halves converge toward (`null`: git could not name one). */
  head: string | null;
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
 * The caller's process must already run as `namespace`
 * (`actAsCheckoutNamespace`) — the served dist is resolved from it.
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
  const deployment = await readServedDeployment();
  const head = deployment.target.resolved ? deployment.target.value : null;
  let ledger: ConvergenceDecision["ledger"] = "present";
  const lastAttempt = async (
    target: AttemptTarget,
  ): Promise<BuildAttempt | null> => {
    const last = await i.recorder.lastClosedRun(target);
    if (last.kind === "missing-ledger") {
      ledger = "missing";
      return null;
    }
    if (last.kind === "none") return null;
    return { commit: last.commitHash, ok: last.exitCode === 0 };
  };

  const autoBuild = readEffectiveConfigFromDiskSync(buildConfig, {
    root: i.root,
    userConfigDir: configDir.file(i.namespace),
    hierarchyPath: BUILD_HIERARCHY_PATH,
  }).autoBuild;
  const main =
    autoBuild &&
    wantsBuild(deployment, await lastAttempt({ only: MAIN_COMPOSITION_ID }));

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
    const wants = compositionWantsRebuild({
      mode: item.serve,
      marker,
      head,
      lastAttempt: await lastAttempt({ includes: item.id }),
      now: i.now,
    });
    if (wants) compositions.push(item.id);
  }

  return { main, compositions, head, ledger };
}

// The build config's owning plugin — where its jsonc files live under
// `config/` and in the namespace's user config dir.
const BUILD_HIERARCHY_PATH = asPath(asPluginId("build"));
