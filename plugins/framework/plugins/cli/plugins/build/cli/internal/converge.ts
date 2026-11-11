import { resolve } from "node:path";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { envEntries } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import {
  actAsCheckoutNamespace,
  checkoutRef,
  WEB_CORE_RELATIVE,
} from "@plugins/infra/plugins/paths/server";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { runAttached } from "@plugins/infra/plugins/jobs/plugins/supervised-job/cli";
import { createBuildRunRecorder } from "@plugins/build/plugins/run-ledger/cli";
import {
  BUILD_RUN_KIND_ID,
  buildRunIdKind,
} from "@plugins/build/plugins/run-ledger/core";
import { decideConvergence } from "@plugins/build/plugins/converge/cli";
import type {
  GatewayFollowOutcome,
  followMainGateway,
} from "@plugins/infra/plugins/launcher/plugins/gateway-drift/cli";

/** The follow step's barrel — imported at its call (see `runConvergence`). */
const GATEWAY_FOLLOW_MODULE =
  "@plugins/infra/plugins/launcher/plugins/gateway-drift/cli";
interface GatewayFollowModule {
  followMainGateway: typeof followMainGateway;
}
import { readCheckoutCompositions } from "./build-targets";
import { waitForArtifactLock } from "./app-artifacts";

/**
 * The flags `--converge` may be combined with: none but `--allow-main`. What a
 * convergence run builds is ITS decision, so a flag that would shape the build
 * (`--composition`, a migration flag, `--skip-checks`, …) has no meaning here.
 */
export interface ConvergeOptions {
  allowMain?: boolean;
  /** Every other flag the invocation carried, by name — must be empty. */
  otherFlags: string[];
}

/**
 * `./equin build --allow-main --converge` — main's deploy, run from OUTSIDE
 * main's backend.
 *
 * The gateway starts this on every advance of `refs/heads/main`, on its own
 * boot, when its previous run exits with an edge pending, and when a backend
 * asks (`POST /gateway/deploy/converge`). It holds no policy: this run is the
 * commit being deployed deciding with its own code. That split is the fix for
 * the 2026-11-08 incident — every edge of the old loop and its runner lived in
 * main's own backend, so a main that could not serve could not deploy the
 * commit that fixed it.
 *
 * One pass is: wait out any build already running in the checkout (its row and
 * dist are what the decision reads), decide from durable state
 * (`decideConvergence`), and when something is wanted, claim the
 * `build_runs` in-flight slot and run the build as an attached supervised run —
 * the same transcript + exit marker every build leaves, under the id the row
 * was claimed with. Main's own app first, then the compositions, one build per
 * pass; the run loops until the decision is empty.
 *
 * Why it terminates: `wantsBuild` refuses a target already attempted, ok or
 * failed, and the row of the build that just ran is closed before the next
 * decision (by the build itself, else here). A HEAD whose build failed is
 * therefore DECIDED, not retried — the next push is the next attempt. A pass
 * that would repeat the build it just ran is a broken ledger, and throws.
 *
 * The exit status is about the RUN, not the builds it started: 0 when it
 * converged (whatever each build's verdict — that is in the ledger and the
 * bell), non-zero only when it could not decide or start. The gateway files a
 * non-zero exit as a `main-deploy-failed` report.
 *
 * It converges THE CHECKOUT IT RUNS IN — its own app, and on main's checkout
 * the compositions main serves too (`decideConvergence`). The gateway runs it
 * for main alone; in any other checkout it is "build only if this checkout's
 * deployment is behind a commit it has not attempted", which is also what lets
 * a throwaway clone stand in for main end to end without touching main.
 *
 * Then, on main's checkout, the GATEWAY follows main (`followMainGateway`,
 * `infra/launcher/gateway-drift`): when what main would install differs from
 * the machine's running gateway, it is installed and the login service
 * reloaded — rolled back to the previous launch if the new one does not
 * listen. It runs after the builds (a build's backend restart goes through
 * whichever gateway is up) and whatever their verdict, since the gateway's
 * source does not depend on the app building. This run outlives the gateway
 * it replaces (its own process group, `EQUIN_BUILD_DETACHED`), so its exit
 * status reaches no one after a restart: a restart that fails files its own
 * report.
 *
 * D12 (main from a frozen per-commit copy) plugs in here: materialize the
 * commit, build there, and the gateway swap is unchanged.
 */
export async function runConvergence(opts: ConvergeOptions): Promise<number> {
  if (!opts.allowMain || opts.otherFlags.length > 0) {
    console.error(
      [
        "ERROR: --converge takes exactly one other flag, --allow-main.",
        "",
        "What a convergence run builds is its own decision.",
        ...(opts.otherFlags.length > 0
          ? [`Refusing: ${opts.otherFlags.join(", ")}.`]
          : []),
      ].join("\n"),
    );
    return 1;
  }
  const root = await getWorktreeRoot();
  const checkout = await checkoutRef(root);
  const log = (line: string): void =>
    console.log(`[converge ${new Date().toISOString()}] ${line}`);
  let builds: { ok: true; code: number } | { ok: false; error: unknown };
  try {
    builds = { ok: true, code: await convergeBuilds(root, checkout, log) };
  } catch (error) {
    builds = { ok: false, error };
  }
  if (checkout.kind !== "main") {
    if (!builds.ok) throw builds.error;
    return builds.code;
  }
  let followed: GatewayFollowOutcome;
  try {
    // Loaded at the call, through a computed specifier: its closure reaches
    // server barrels and the login-services registry, which `build`'s own
    // codegen regenerates — a static edge would put them in `build`'s run
    // closure and freeze them there (`cli:codegen-manifests-not-frozen`). A
    // convergence run regenerates nothing itself (its builds are child
    // processes), so loading them here, after its builds, freezes nothing.
    const followModule: string = GATEWAY_FOLLOW_MODULE;
    const { followMainGateway } = (await import(
      followModule
    )) as GatewayFollowModule;
    followed = await followMainGateway({ checkout: root, log });
  } catch (error) {
    if (builds.ok) throw error;
    throw new AggregateError(
      [builds.error, error],
      "[converge] the builds and the gateway follow both failed",
    );
  }
  log(`gateway: ${describeFollow(followed)}`);
  if (!builds.ok) throw builds.error;
  // A refused or failed follow filed its own gateway-restart-failed report;
  // a non-zero exit would add a main-deploy-failed one for the same event.
  return builds.code;
}

function describeFollow(o: GatewayFollowOutcome): string {
  switch (o.kind) {
    case "not-applicable":
      return `not followed — ${o.reason}`;
    case "current":
      return "current";
    case "already-attempted":
      return `out of date, this launch already attempted at ${o.at} (${o.outcome})`;
    case "restarted":
      return `restarted onto main's (PID ${o.pid})`;
    case "refused":
      return `not restarted — ${o.reason}`;
    case "failed":
      return o.rolledBack
        ? "main's gateway did not come up; rolled back"
        : "main's gateway did not come up, and the rollback failed";
  }
}

/** The build loop: decide, build, until the decision is empty. */
async function convergeBuilds(
  root: AppPath,
  checkout: Awaited<ReturnType<typeof checkoutRef>>,
  log: (line: string) => void,
): Promise<number> {
  const namespace = await actAsCheckoutNamespace(root);
  const webDir = resolve(root, WEB_CORE_RELATIVE);
  const recorder = createBuildRunRecorder(namespace);
  try {
    let previous: string | null = null;
    for (;;) {
      await waitForArtifactLock(webDir);
      const decision = await decideConvergence({
        root,
        checkout,
        namespace,
        manifests: readCheckoutCompositions(root, checkout),
        recorder,
        now: new Date(),
      });
      const head = decision.head?.slice(0, 9) ?? "(no HEAD)";
      // Main first, and one build per pass: the in-flight slot is single and
      // target-blind, and the composition build follows on the next pass.
      const targets = decision.main
        ? [MAIN_COMPOSITION_ID]
        : decision.compositions;
      if (targets.length === 0) {
        log(`converged at ${head}: nothing to build`);
        return 0;
      }
      const key = `${decision.head ?? "-"} ${targets.join(",")}`;
      if (key === previous) {
        throw new Error(
          `[converge] the build of ${targets.join(", ")} at ${head} just ran, and the decision ` +
            "still wants it: its attempt is not in the ledger, so this loop would not terminate.",
        );
      }
      previous = key;

      const buildId = buildRunIdKind.mint();
      const claim = await recorder.insertRun({
        id: buildId,
        targets,
        trigger: "auto",
        commitHash: decision.head,
        pid: process.pid,
      });
      if (claim === "lost") {
        // A live build took the slot between the lock wait and the claim. It
        // holds the build lock, so the next run waits behind it; nothing is
        // lost because the ref edge that matters re-runs this.
        log(`a live build of ${namespace} holds the slot — stopping`);
        return 0;
      }
      log(`building ${targets.join(", ")} at ${head} — ${buildId}`);
      const exitCode = await runAttached({
        namespace,
        kindId: BUILD_RUN_KIND_ID,
        runId: buildId,
        argv: [
          process.execPath,
          resolve(process.argv[1] ?? ""),
          "build",
          "--allow-main",
          // After --allow-main: commander's variadic is greedy to the next flag.
          ...(decision.main ? [] : ["--composition", ...targets]),
        ],
        cwd: root,
        env: {
          ...process.env,
          // A claimed row is the build's (it closes it); with no ledger yet the
          // build mints its own once Postgres answers (`BUILD_RELAYED`).
          ...envEntries(
            claim === "claimed"
              ? { BUILD_ID: buildId }
              : { BUILD_ID: buildId, BUILD_RELAYED: "1" },
          ),
        },
      });
      // The build closes its own row on every verdict; this is the backstop for
      // the ways it can end without one (a throw, an early exit, a signal), so
      // the next decision sees this attempt. First writer wins.
      if (claim === "claimed") await recorder.closeRun(buildId, exitCode);
      log(`build ${buildId} exited ${exitCode}`);
      // No ledger to record the attempt in, so the ledger cannot end the loop:
      // one build, then stop. The next edge decides against the ledger this
      // build created.
      if (claim === "unavailable" || decision.ledger === "missing") return 0;
    }
  } finally {
    await recorder.close();
  }
}
