import { resolve } from "node:path";
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
  const namespace = await actAsCheckoutNamespace(root);
  const webDir = resolve(root, WEB_CORE_RELATIVE);
  const recorder = createBuildRunRecorder(namespace);
  const log = (line: string): void =>
    console.log(`[converge ${new Date().toISOString()}] ${line}`);
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
