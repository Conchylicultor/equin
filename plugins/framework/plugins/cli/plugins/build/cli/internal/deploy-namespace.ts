import os from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { fixed, retryUntil } from "@plugins/packages/plugins/retry/core";
import { callEndpoint } from "@plugins/infra/plugins/endpoints/server";
import { EndpointError } from "@plugins/infra/plugins/endpoints/core";
import { getHealth } from "@plugins/infra/plugins/health/core";
import { propagateConfigToUser } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { ensureDatabase } from "@plugins/database/plugins/admin/server";
import {
  stampCompositionMarker,
  writeWorktreeSpec,
  type CompositionMarker,
} from "@plugins/infra/plugins/worktree/server";
import {
  namespaceUrl,
  type CheckoutRef,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import { configDir } from "@plugins/config_v2/data-dirs";
import { applyPluginMoves } from "@plugins/plugin-meta/plugins/relocate/core";
import type {
  Lane,
  Priority,
} from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { adaptiveTimeoutMs } from "@plugins/framework/plugins/cli/plugins/bootstrap/cli";
import {
  SERVER_CORE_RELATIVE,
  worktreeDataDir,
} from "@plugins/infra/plugins/paths/server";
import {
  buildAndPublishWebDist,
  type ArtifactHooks,
  type HeavyAdmission,
  type HeavyJob,
  type StepResult,
  type WebDistTarget,
} from "./app-artifacts";
import type { BuildTarget } from "./build-targets";

/**
 * Deploy ONE namespace into the live dev cluster: the per-target half of
 * `./singularity build`, run once per `--composition` (and once, unnamed, for a
 * plain build).
 *
 *   marker → dist → database → config → (marker again) + spec → restart → health
 *   probe
 *
 * It exists as its own module for the reason the plan for this phase gives:
 * `run.ts`'s terminal funnel closes over eleven invocation-scoped values, and
 * fanning out inside the largest closure in the repo is how that file reached
 * 1900 lines. So the split is by SCOPE, not by topic — everything here is a
 * function of one (composition, checkout) pair, and everything that is a
 * function of the invocation (the lock, codegen, the checks pass, the ledger
 * row, the transcript, the profile, the ONE verdict) stays in `run.ts`.
 *
 * FAILURE IS A TYPE. This function never calls `process.exit` and never prints a
 * verdict — it returns a discriminated result, exactly like `ArtifactBuildResult`
 * does one level down, and `run.ts` routes a failure into its single funnel.
 * That is what lets the caller say what published, what failed, and what was not
 * attempted, in one banner, for an invocation that had several targets.
 *
 * It absorbs the old `compose-serve.ts`'s `serveOne`: the provenance marker, and
 * the spec-LAST ordering. What it does NOT absorb is that stage's tolerance for
 * a failed restart — a composition backend that crashes on boot now fails the
 * build the same way the main app's does, because "the build said OK and the app
 * 502s" is the one outcome a deploy verb may never produce.
 */
export type DeployNamespaceResult =
  | {
      ok: true;
      /** Soft degrades folded into the invocation's OK verdict (still booting, …). */
      notes: string[];
    }
  | {
      ok: false;
      /** Step labels for the verdict headline, as `ArtifactBuildResult` names them. */
      failedLabels: string[];
      /** The failure's own sentences, rendered by `run.ts`'s funnel. */
      reason: string[];
    };

export interface DeployNamespaceOptions {
  target: BuildTarget;
  /** The checkout being built. */
  root: string;
  /** Only ever the `.build.lock`'s home — see `BuildWebDistOptions.webDir`. */
  webDir: string;
  buildId: string;
  /** HEAD when this build took the lock — the commit the marker records. */
  commit: string | null;
  /** Which checkout `root` is; recorded in the marker beside the composition. */
  checkout: CheckoutRef;
  minify: boolean;
  /** The red agent-worktree frame — true for every target of a worktree build. */
  experimental: boolean;
  lane: Lane;
  priority: Priority;
  background: boolean;
  /** Validation, shared with the frontend job's ONE host grant. First target only. */
  companions: HeavyJob[];
  admission: HeavyAdmission;
  /** `--no-restart`: publish the artifacts and leave the gateway alone. */
  restart: boolean;
  onSteps: (steps: StepResult[]) => void;
  hooks: ArtifactHooks;
}

/**
 * The gateway's authoritative state for one namespace, or `null` when the
 * gateway is unreachable (connection refused / timeout) or the namespace is
 * absent from the snapshot. Only connection/timeout errors are swallowed;
 * anything unexpected is rethrown so it fails loudly.
 */
async function getWorktreeState(
  name: Namespace,
): Promise<{ state: string; lastSpawnErr: string } | null> {
  try {
    const resp = await fetch("http://localhost:9000/gateway/worktrees", {
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const entries = (await resp.json()) as Array<{
      name?: string;
      state?: string;
      lastSpawnErr?: string;
    }>;
    if (!Array.isArray(entries)) return null;
    const entry = entries.find((e) => e.name === name);
    if (!entry) return null;
    return { state: entry.state ?? "", lastSpawnErr: entry.lastSpawnErr ?? "" };
  } catch (err) {
    // Gateway not running (TypeError/connection refused) or request timed out
    // (DOMException AbortError). Anything else is unexpected — rethrow.
    if (!(err instanceof TypeError) && !(err instanceof DOMException))
      throw err;
    return null;
  }
}

/**
 * Per-process identity of the backend currently served for `name`, or null when
 * nothing is serving yet (cold start) or it's unreachable. The gateway only ever
 * routes to a backend past its ready barrier, so a change in this value across a
 * restart proves the NEW (ready) backend took over — not the stale old one.
 */
async function readHealthStartedAt(name: Namespace): Promise<number | null> {
  try {
    const { startedAt } = await callEndpoint(
      getHealth,
      {},
      { origin: namespaceUrl(name), signal: AbortSignal.timeout(5_000) },
    );
    return startedAt;
  } catch (err) {
    // Unreachable (TypeError), timed out (DOMException), not serving (a
    // non-2xx), or a previous backend whose reply predates this checkout's
    // contract (ZodError) — none names a served startedAt. Anything else is
    // unexpected — rethrow.
    if (
      !(err instanceof TypeError) &&
      !(err instanceof DOMException) &&
      !(err instanceof EndpointError) &&
      !(err instanceof z.ZodError)
    )
      throw err;
    return null;
  }
}

/**
 * What the health probe concluded. Three arms rather than "a note or a throw":
 * a soft degrade (the server is still booting under host load, but the artifacts
 * are valid) and an unambiguous deploy failure are genuinely different outcomes,
 * and only the caller owns the verdict that reports either.
 */
type HealthOutcome =
  { kind: "ok"; note: string | null } | { kind: "failed"; reason: string[] };

/**
 * Verify the freshly-restarted backend actually took over. `previousStartedAt`
 * is the per-process identity of the backend serving BEFORE the restart POST
 * (null on a cold start, where nothing was serving yet). On a hot restart the
 * gateway is blue/green: it swaps `w.active` to the new backend only once that
 * backend clears its ready barrier, so a served `startedAt` greater than
 * `previousStartedAt` proves the NEW (ready) backend is live. Reading only
 * `resp.ok` is not enough — a failed hot-restart leaves the OLD backend
 * answering `{ok:true}` with stale code and the build would falsely pass.
 * `restartError` carries the gateway's 500 body, if any, for the failure message.
 */
async function probeHealth(
  name: Namespace,
  previousStartedAt: number | null,
  restartError: string | null,
): Promise<HealthOutcome> {
  const isRestart = previousStartedAt != null;
  const deadline = adaptiveTimeoutMs(20_000, 120_000);
  console.log(
    `Probing /api/health... (deadline ${Math.round(deadline / 1000)}s)`,
  );
  const site = namespaceUrl(name);
  let lastStatus: number | string = "no response";
  const result = await retryUntil<true, Promise<HealthOutcome>>(
    async () => {
      try {
        const { startedAt } = await callEndpoint(
          getHealth,
          {},
          { origin: site, signal: AbortSignal.timeout(5_000) },
        );
        // Cold start: any healthy backend is the one we just built.
        if (!isRestart) return true;
        // Hot restart: the gateway swaps `w.active` to the new backend only
        // after it passes `waitReady`, so a served `startedAt` past the old
        // one proves the new backend is live AND ready. Without this a failed
        // hot-restart leaves the old backend answering ok and the build
        // falsely passes.
        if (startedAt > previousStartedAt) return true;
        lastStatus = `stale backend (startedAt ${startedAt} <= ${previousStartedAt})`;
        return null;
      } catch (err) {
        // A non-2xx, a per-attempt abort (DOMException — just a slow request)
        // or a reply the contract rejects (a stale backend) — record it and let
        // retryUntil try again like any other failed attempt.
        lastStatus =
          err instanceof EndpointError
            ? err.status
            : err instanceof Error
              ? err.message
              : String(err);
      }
      return null;
    },
    {
      delay: fixed(250),
      deadline,
      // On deadline we ask the gateway for the namespace's authoritative state
      // instead of blindly declaring a crash. A stopwatch expiring is not the
      // same as a boot failure under host load.
      onDeadline: async (): Promise<HealthOutcome> => {
        // A hot restart whose new backend never became the served backend is an
        // unambiguous deploy failure: the gateway SIGKILLed it (state reverts to
        // "running", never "broken") and is still serving the previous backend's
        // stale code. There is no lenient interpretation for this path.
        if (isRestart) {
          const detail = restartError
            ? `Gateway restart error: ${restartError}`
            : "";
          return {
            kind: "failed",
            reason: [
              `NOT DEPLOYED. ${site} still serves the previous backend (stale code).`,
              `The freshly-built backend never became ready within ${Math.round(deadline / 1000)}s — ` +
                `it failed its onReadyBlocking ready barrier (last: ${lastStatus}).`,
              ...(detail ? [detail] : []),
              `Inspect the backend log at ${join(worktreeDataDir(name), "logs")} for the throw.`,
            ],
          };
        }
        const load1 = Math.round((os.loadavg()[0] ?? 0) * 10) / 10;
        const info = await getWorktreeState(name);
        if (!info) {
          console.warn(
            `Server didn't respond on /api/health within ${Math.round(deadline / 1000)}s ` +
              `(last: ${lastStatus}) and the gateway is unreachable. ` +
              `Build artifacts are valid; not blocking the build.`,
          );
          return {
            kind: "ok",
            note: "server still booting (gateway unreachable)",
          };
        }
        switch (info.state) {
          case "broken":
            return {
              kind: "failed",
              reason: [
                `Server crashed during boot (state: broken): ${info.lastSpawnErr || "no error reported"}.`,
                `NOT DEPLOYED. ${site} still serves the previous build.`,
                `Inspect the backend log at ${join(worktreeDataDir(name), "logs")} for the throw.`,
              ],
            };
          case "running":
            console.log("Server is up.");
            return { kind: "ok", note: null };
          case "starting":
          case "restarting":
          case "idle":
            console.warn(
              `Server still booting after ${Math.round(deadline / 1000)}s under host load ` +
                `(load avg ${load1}). Build artifacts are valid; the gateway will finish ` +
                `bringing it up on demand. Not blocking the build.`,
            );
            return { kind: "ok", note: "server still booting under host load" };
          default:
            console.warn(
              `Server didn't respond on /api/health within ${Math.round(deadline / 1000)}s ` +
                `(gateway state: ${info.state || "unknown"}, last: ${lastStatus}). ` +
                `Build artifacts are valid; not blocking the build.`,
            );
            return { kind: "ok", note: "server still booting" };
        }
      },
    },
  );
  return result === true ? { kind: "ok", note: null } : result;
}

/**
 * What the gateway restart POST left behind. A discriminated result rather than
 * three mutable locals: `restartError` and `gatewayUp` are read AFTER the call,
 * and a value assigned inside a callback and read outside it is exactly the
 * shape that reads as "definitely null" to a human skimming.
 *
 * `gatewayUp: false` is not a failure — no gateway means the backend spawns on
 * the next request, which is the normal state on a box where `singularity start`
 * has not run.
 */
type RestartOutcome =
  | { kind: "failed"; reason: string[] }
  | { kind: "done"; gatewayUp: boolean; restartError: string | null };

/**
 * Ask the gateway to restart this namespace's backend, tolerantly: 404 means
 * nothing is running (it spawns on first request), an unreachable gateway means
 * the same. A 500 is the one ambiguous answer — a real boot crash, or a
 * readiness timeout under load — so the gateway's own authoritative state
 * decides, and only `broken` fails the build here; anything else is left for
 * `probeHealth` to adjudicate by comparing `startedAt`.
 */
async function restartBackend(
  ns: Namespace,
  site: string,
): Promise<RestartOutcome> {
  console.log("Restarting backend...");
  let restartError: string | null = null;
  try {
    const resp = await fetch(
      `http://localhost:9000/gateway/worktrees/${ns}/restart`,
      {
        method: "POST",
        signal: AbortSignal.timeout(adaptiveTimeoutMs(30_000, 130_000)),
      },
    );
    if (resp.ok) {
      console.log("Backend restarted");
    } else if (resp.status === 404) {
      console.log("No running backend to restart");
    } else if (resp.status === 500) {
      restartError = (await resp.text().catch(() => "")).trim() || null;
      const info = await getWorktreeState(ns);
      if (info?.state === "broken") {
        return {
          kind: "failed",
          reason: [
            `Server crashed during boot (state: broken): ${info.lastSpawnErr || "no error reported"}` +
              `${restartError ? `: ${restartError}` : ""}.`,
            `NOT DEPLOYED. ${site} still serves the previous build. Check server logs.`,
          ],
        };
      }
      console.warn(
        `Backend restart returned 500${restartError ? `: ${restartError}` : ""} — verifying the new backend took over…`,
      );
    } else {
      console.warn(`Backend restart returned ${resp.status}`);
    }
  } catch (err) {
    // Gateway not running (TypeError/connection refused) or the request timed
    // out (DOMException AbortError). Anything else is unexpected — rethrow.
    if (!(err instanceof TypeError) && !(err instanceof DOMException))
      throw err;
    console.log("Gateway not reachable, skipping backend restart");
    return { kind: "done", gatewayUp: false, restartError: null };
  }
  return { kind: "done", gatewayUp: true, restartError };
}

/** The ordered per-namespace deploy sequence. See the module docblock. */
export async function deployNamespace(
  opts: DeployNamespaceOptions,
): Promise<DeployNamespaceResult> {
  const { target, root, hooks } = opts;
  const ns = target.namespace;
  const site = namespaceUrl(ns);
  const notes: string[] = [];

  const span = async <T>(
    id: string,
    phase: string,
    label: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    const end = hooks.span(id, phase, label);
    try {
      return await run();
    } finally {
      end();
    }
  };

  // The provenance this namespace carries, built ONCE so the claim below and the
  // re-stamp at the commit point write identical bytes — which is what makes the
  // second write invisible in the normal case.
  //
  // The checkout's own app has no marker, deliberately: that namespace belongs
  // to the checkout, and `namespaceCollision`'s checkout arm refuses to create a
  // git worktree whose namespace carries one — so stamping it here would make
  // this build the reason the next `att-x` worktree cannot exist. `null` is that
  // absence, and it is what makes `stampMarker` below a no-op for main.
  const marker: CompositionMarker | null = target.isMainComposition
    ? null
    : {
        composition: target.composition,
        // The other half of the pair, recorded where it is minted. A namespace
        // does not decompose (`sonata` is `sonata` on main and `sonata.att-x` in
        // a worktree, and a single label is ambiguous by construction), so this
        // is the only place that can ever say which checkout serves it.
        checkout: opts.checkout.kind === "main" ? null : opts.checkout.name,
        builtAt: new Date().toISOString(),
        buildId: opts.buildId,
        commit: opts.commit,
      };
  const stampMarker = (): void => {
    if (marker !== null) stampCompositionMarker(ns, marker);
  };

  // MARKER FIRST — before anything else writes into the namespace dir, and only
  // for a composition that is CLAIMING one. From the moment this dir has content
  // it must read as ours, or a crash mid-build leaves a marker-less dir the
  // collision guard then refuses forever.
  //
  // This is the CLAIM, not the guarantee: see the second stamp at the register
  // step below, and `stampCompositionMarker`'s docblock for why one is not
  // enough.
  stampMarker();

  // WHICH dist this target publishes: the one SERVED for this namespace. The
  // caller swept its leftovers up front, through this same identity.
  const distTarget: WebDistTarget = { kind: "served", name: ns };

  // The heavy section under ONE host CPU grant, then the atomic dist publish.
  const artifact = await buildAndPublishWebDist({
    root,
    webDir: opts.webDir,
    target: distTarget,
    buildId: opts.buildId,
    // The commit the dist is stamped with. The SAME value the marker records
    // (`opts.commit`), sampled once when this build took the lock — so a
    // namespace's `.build-commit` and its `composition.json` can never name
    // different trees, even when the checkout moves mid-build.
    headAtStart: opts.commit,
    // WHAT the fleet is planned from. The main composition's registry IS the
    // committed one, which `compositionFleetSource` answers for by name — so
    // this is the composition id on every target, with no arm for main.
    composition: target.composition,
    minify: opts.minify,
    // A served dist links into the shared content-addressed store; only the
    // release path materializes real copies.
    materialize: false,
    experimental: opts.experimental,
    lane: opts.lane,
    priority: opts.priority,
    background: opts.background,
    companions: opts.companions,
    admission: opts.admission,
    onSteps: opts.onSteps,
    hooks,
  });
  if (!artifact.ok) {
    return {
      ok: false,
      failedLabels: artifact.failedLabels,
      reason: [
        `NOT DEPLOYED. Nothing was published; ${site} still serves the previous build.`,
        `The frontend compiled, but the artifact was discarded.`,
      ],
    };
  }

  // DATABASE — opposite operations, not one function with a flag.
  //
  // The checkout's own app runs on the worktree FORK: it carries main's data and
  // is created by a graphile job at conversation time, so creating one empty
  // here would be actively wrong. The caller has already waited for it — that
  // wait is hoisted into the invocation prefix because the `build_runs` row this
  // build opened lives in that same database, and because a missing fork must
  // fail in seconds rather than after the frontend build. So there is nothing
  // left to do for it here.
  //
  // Every other composition gets an EMPTY database, created race-safely; the
  // backend's boot migrator fills in the schema on its first spawn.
  if (!target.isMainComposition) {
    await span("ensureDatabase", "build:database", "ensure database", () =>
      ensureDatabase(ns),
    );
  }

  // Saved settings follow plugin moves BEFORE propagation reads them: replay
  // the committed move ledger onto this namespace's user-layer config, so the
  // dir is shaped like the code being deployed (see relocate's apply-moves).
  await span(
    "applyPluginMoves",
    "build:codegen",
    "apply plugin moves to user config",
    async () => {
      for (const a of applyPluginMoves({
        root,
        userConfigDir: configDir.file(ns),
      })) {
        console.log(
          `Plugin move ${a.move.from} → ${a.move.to}: moved ${a.moved.length} saved config file(s), ` +
            `rewrote ${a.rewritten.length}` +
            (a.kept.length > 0
              ? `; kept ${a.kept.length} at the old path (destination already had one): ${a.kept.join(", ")}`
              : ""),
        );
      }
    },
  );

  await span(
    "propagateConfig",
    "build:codegen",
    "propagate config to user",
    async () => {
      console.log("Propagating config to user...");
      const { migrations } = await propagateConfigToUser({
        root,
        userConfigDir: configDir.file(ns),
      });
      for (const m of migrations) {
        console.log(
          `Config migration ${m.key}: rewrote ${m.rewritten.length} saved config file(s)`,
        );
      }
    },
  );

  // SPEC LAST of the filesystem writes (mirrors `bootSelfContainedApp`): the
  // gateway discovers a namespace only once its DB and dist exist, so a
  // freshly-spawned backend never races DB creation — a 3D000 boot crash is not
  // retried.
  const endRegister = hooks.span(
    "registerWorktree",
    "build:deploy",
    "register worktree",
  );
  console.log("Registering worktree...");
  // MARKER AGAIN, in the same breath as the spec. The spec write is the instant
  // the namespace becomes live, so it is also the instant its provenance has to
  // be true — and between the claim above and here this build spent most of its
  // wall time parked on the host CPU grant, during which the namespace dir is
  // just a directory on a shared filesystem. One did get removed mid-wait
  // (2026-08-19), and because every other artifact in the dir is written down
  // here, the namespace came up live and served with no marker: unre-servable,
  // unresettable, reported as not served. The write is atomic, idempotent and
  // byte-identical to the claim, so when nothing went wrong this line does
  // nothing at all; when something did, it is the line that repairs it. It
  // throws if the marker cannot be read back, so a marker-less namespace can
  // never reach the spec write at all.
  stampMarker();
  writeWorktreeSpec({
    name: ns,
    // The back-pointer a reader follows the other way: `deploysForCheckout`
    // matches specs against this same constant to answer which deploys a
    // checkout published, so writer and reader share one spelling.
    server: resolve(root, SERVER_CORE_RELATIVE),
    web: artifact.livePath,
    // The `server` tree is this checkout's, shared with every namespace it
    // serves, so this is the only thing that tells the spawned backend WHICH
    // registry to load — the committed one for the main composition, the
    // filtered `<dir>.composition.<id>.generated.ts` for any other.
    composition: target.composition,
  });
  endRegister();

  if (!opts.restart) {
    notes.push(`restart skipped (${ns})`);
    return { ok: true, notes };
  }

  // Snapshot the currently-served backend's per-process identity BEFORE the
  // restart. probeHealth compares against it to prove the NEW backend took over,
  // rather than the old one still answering ok with stale code.
  const previousStartedAt = await readHealthStartedAt(ns);
  const restart = await span(
    "restartBackend",
    "build:deploy",
    "restart backend",
    () => restartBackend(ns, site),
  );
  if (restart.kind === "failed") {
    return {
      ok: false,
      failedLabels: ["backend crashed"],
      reason: restart.reason,
    };
  }

  // Smoke-test the server boot. tsc catches static import errors but the server
  // can still fail to evaluate (missing env, init-time cycle, …) and surface as
  // a 502 on first request. Hit /api/health to force a boot and fail the build
  // if the server can't come up.
  if (restart.gatewayUp) {
    const health = await span(
      "probeHealth",
      "build:deploy",
      "health probe",
      () => probeHealth(ns, previousStartedAt, restart.restartError),
    );
    if (health.kind === "failed") {
      return {
        ok: false,
        failedLabels: ["backend never ready"],
        reason: health.reason,
      };
    }
    if (health.note !== null) notes.push(health.note);
  }

  return { ok: true, notes };
}
