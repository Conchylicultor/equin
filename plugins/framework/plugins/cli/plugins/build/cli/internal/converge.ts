import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { resolve } from "node:path";
import { readOomKillCount } from "@plugins/packages/plugins/host-memory/core";
import { deadBuildExitCode } from "./failure-end";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { envEntries } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import {
  actAsCheckoutNamespace,
  checkoutRef,
  worktreeArtifacts,
} from "@plugins/infra/plugins/paths/server";
import { waitForFlock } from "@plugins/packages/plugins/flock/core";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import {
  getMainRepoRoot,
  getWorktreeRoot,
} from "@plugins/infra/plugins/spawn/core";
import { runInBuildSlot } from "@plugins/infra/plugins/git/plugins/main-slots/cli";
import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { runAttached } from "@plugins/infra/plugins/jobs/plugins/supervised-job/cli";
import { createBuildRunRecorder } from "@plugins/build/plugins/run-ledger/cli";
import {
  BUILD_RUN_KIND_ID,
  buildRunIdKind,
} from "@plugins/build/plugins/run-ledger/core";
import {
  convergenceBuild,
  decideConvergence,
  describeNothingToBuild,
} from "@plugins/build/plugins/converge/cli";
import {
  buildStatusOf,
  killedSignalName,
} from "@plugins/build/plugins/build-status/core";
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
import { finishBuildSubSteps, requestFollow } from "@plugins/installer/cli";
import { reportLockWait } from "@plugins/installer/plugins/waits/cli";
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
 * was claimed with. Everything due at the decided HEAD — main's own app and
 * the compositions — is ONE build (`convergenceBuild`: one slot, one row with
 * every target); the run loops until the decision is empty.
 *
 * Why it terminates: `wantsBuild` refuses a target whose build gave a verdict,
 * ok or failed, and the row of the build that just ran is closed before the
 * next decision (by the build itself, else here). A HEAD whose build failed is
 * therefore DECIDED, not retried — the next push (or a manual Build) is the
 * next attempt. A build that ended with no verdict (killed by the OOM killer,
 * interrupted, superseded) is retried by the NEXT run, a bounded number of
 * times (`MAX_NO_VERDICT_ATTEMPTS`), never by this one; the run that spends
 * the last one fails, so the gateway files a `main-deploy-failed` report. A pass
 * that would repeat the build it just ran for any other reason is a broken
 * ledger, and throws.
 *
 * A pass that builds nothing says why (`describeNothingToBuild`): "converged"
 * only when the served dist names HEAD, else the failed run and the commit
 * still served.
 *
 * The exit status is about the RUN, not the builds it started: 0 when it
 * converged or decided (whatever each build's verdict — that is in the ledger,
 * the bell and a failed main build's `build-failed` report), non-zero when it
 * could not decide or start, or when it spent a commit's last no-verdict retry. The gateway files a
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
 * The whole run — builds and gateway follow — holds the namespace's deploy
 * lock (`worktreeArtifacts.deployLock`) exclusively. A build's exit marker is
 * not "the deploy is done": the follow that comes after it can restart the
 * gateway and every backend seconds later (2026-11-14, `desktop.fullscreen-budget`
 * was started by the marker and drove main through that restart: connection
 * refused, its demo never rendered). What must start on a settled deploy waits
 * for this lock instead of racing the run. A second run (the restarted
 * gateway's own boot run) waits for the first to end.
 *
 * On main, each build runs in a SLOT (`infra/git/main-slots`): the run checks
 * the decided commit out into a free slot no push writes into (never one an
 * app lives in), hands it to `<slot>/equin build`, and the build points each
 * deployed app's `current/<namespace>` link at the slot once that app is
 * healthy; the pool is reclaimed after each build. The gateway starts this
 * run from main's link (the repo root before any slot exists), so the
 * decision is made by the code main serves, never by a tree a push is
 * rewriting.
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
  const namespace = await actAsCheckoutNamespace(root);
  const lockStartedAt = Date.now();
  // Run as an install's build step, the wait for the gateway's own run (a
  // fresh install's first boot converges at once) is reported naming that
  // run's build (installer/waits) — the install reuses its work rather than
  // building the same tree twice. And it asks to FOLLOW that build: once the
  // build takes the request, its sub-steps and counts are this step's (the
  // wait ends there), so the install shows main's build as it runs.
  const lockWait = reportLockWait("build");
  const withdrawFollow = requestFollow(
    worktreeArtifacts.installFollow(namespace),
  );
  let deployLock: Awaited<ReturnType<typeof waitForFlock>>;
  let followed = false;
  try {
    deployLock = await waitForFlock(worktreeArtifacts.deployLock(namespace));
  } finally {
    lockWait.end();
    followed = withdrawFollow().followed;
  }
  const lockWaitMs = Date.now() - lockStartedAt;
  if (lockWaitMs >= 1000)
    log(
      `waited ${Math.round(lockWaitMs / 1000)} s for the deploy lock (another convergence run held it)`,
    );
  try {
    return await convergeAndFollow(root, checkout, namespace, log, followed);
  } finally {
    await deployLock.release();
  }
}

/** One convergence run under the deploy lock: the builds, then the gateway follow. */
async function convergeAndFollow(
  root: AppPath,
  checkout: Awaited<ReturnType<typeof checkoutRef>>,
  namespace: Namespace,
  log: (line: string) => void,
  installFollowed: boolean,
): Promise<number> {
  let builds: { ok: true; code: number } | { ok: false; error: unknown };
  try {
    builds = {
      ok: true,
      code: await convergeBuilds(
        root,
        checkout,
        namespace,
        log,
        installFollowed,
      ),
    };
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
    // The checkout the machine's gateway deploys (`-main-checkout`) is the
    // repo's own — the git store whose `refs/heads/main` it watches — not the
    // slot this run happens to run from.
    followed = await followMainGateway({
      checkout: await getMainRepoRoot(root),
      log,
    });
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
      return `handed over to main's (gateway PID ${o.pid}; no backend restarted)`;
    case "switching":
      return `restarting the service onto main's in a helper of its own (PID ${o.helperPid}) — this run may end with the old gateway`;
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
  namespace: Namespace,
  log: (line: string) => void,
  /** An install step that followed the build it waited for: its sub-steps are told. */
  followed: boolean,
): Promise<number> {
  const recorder = createBuildRunRecorder(namespace);
  // This run built nothing: another run (the gateway's own, on an install's
  // first boot) did. Run as an install's build step that did not follow that
  // build, its sub-steps are none of this step's work — reported skipped, so
  // the view closes them rather than leaving them pending. A no-op outside an
  // install.
  const builtElsewhere = (): void => {
    if (!followed) finishBuildSubSteps(true);
  };
  try {
    let built = false;
    // `<head> <target>` of every build this run made, and their run ids.
    const builtHere = new Set<string>();
    const ranHere = new Set<string>();
    for (;;) {
      await waitForArtifactLock(root);
      const decision = await decideConvergence({
        root,
        checkout,
        namespace,
        manifests: readCheckoutCompositions(root, checkout),
        recorder,
        now: new Date(),
      });
      const head = decision.head?.slice(0, 9) ?? "(no HEAD)";
      // Every app due at this HEAD in ONE build: main's own and the
      // compositions together — one slot, one `build_runs` row with all
      // targets (`convergenceBuild`). Apps due at another HEAD are a later
      // pass: a build is of one commit.
      const build = convergenceBuild(decision);
      if (build === null) {
        const said = describeNothingToBuild(decision);
        if (!built) builtElsewhere();
        if (said.level === "error" && built) {
          // This run spent the commit's last no-verdict retry: nothing
          // automatic will try it again, so fail the run and the gateway files
          // it (`main-deploy-failed`) where people look. Once — a later run
          // deciding the same says so in its log only, or every trigger (the
          // quarter-hourly composition tick) would file it again.
          console.error(`[converge] ${said.line}`);
          return 1;
        }
        log(said.line);
        return 0;
      }
      const { targets } = build;
      const head40 = decision.head ?? "-";
      const again = targets.filter((t) => builtHere.has(`${head40} ${t}`));
      if (again.length > 0) {
        // A target this run already built at this HEAD is wanted again. Fine
        // only as a retry of the very build this run made, ended with no
        // verdict (killed, interrupted, superseded) — and not here: whatever
        // ended it (the host's memory, a shutdown) is likely still true this
        // second. The next convergence trigger retries it, boundedly
        // (`wantsBuild`'s MAX_NO_VERDICT_ATTEMPTS). Anything else means the
        // ledger lost this run's attempt, and the loop would not terminate.
        const retriesOwnBuild = again.every((t) =>
          decision.retries.some((r) => r.target === t && ranHere.has(r.newest)),
        );
        if (!retriesOwnBuild) {
          throw new Error(
            `[converge] the build of ${again.join(", ")} at ${head} just ran, and the decision ` +
              "still wants it: its attempt is not in the ledger, so this loop would not terminate.",
          );
        }
        log(
          `the build of ${again.join(", ")} at ${head} ended without a verdict: ` +
            "not retried in this run — the next convergence trigger retries it",
        );
        return 0;
      }
      // Main's build is of ONE commit, checked out into a slot: refuse before
      // claiming a row when git named none.
      if (checkout.kind === "main") slotSha(decision.head);

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
        if (!built) builtElsewhere();
        return 0;
      }
      const retrying = targets.filter((t) =>
        decision.retries.some((r) => r.target === t),
      );
      log(
        `building ${targets.join(", ")} at ${head} — ${buildId}` +
          (retrying.length > 0
            ? ` (retrying ${retrying.join(", ")}: an earlier build of this commit ended without a verdict)`
            : ""),
      );
      const buildArgs = [
        "build",
        "--allow-main",
        // After --allow-main: commander's variadic is greedy to the next flag.
        ...build.compositionArgs,
      ];
      const env: Record<string, string | undefined> = {
        ...process.env,
        // A claimed row is the build's (it closes it); with no ledger yet the
        // build mints its own once Postgres answers (`BUILD_RELAYED`).
        ...envEntries<string>(
          claim === "claimed"
            ? { BUILD_ID: buildId }
            : { BUILD_ID: buildId, BUILD_RELAYED: "1" },
        ),
      };
      // Read around the child: a build the kernel OOM-killed whole records
      // nothing itself, and this run's close is its row's first write.
      const readOomKills = () =>
        readOomKillCount(process.platform, (path) => readFile(path, "utf8"));
      const oomKillsAtStart = await readOomKills();
      let exitCode: number;
      if (checkout.kind === "main") {
        // Main builds in a SLOT (`infra/git/main-slots`): a linked worktree
        // checked out at exactly the commit decided on, which no push writes
        // into — so the build reads one commit for its whole run. The child
        // build holds the slot (`runInBuildSlot`), and points `current` at it
        // once its deploy is healthy.
        try {
          exitCode = await buildInSlot({
            sha: slotSha(decision.head),
            repoRoot: await getMainRepoRoot(root),
            namespace,
            buildId,
            buildArgs,
            env,
            log,
          });
        } catch (err) {
          // No slot, so no build to close the row: close it here, or the
          // in-flight index would stay held against every later build.
          if (claim === "claimed") await recorder.closeRun(buildId, 1);
          throw err;
        }
      } else {
        exitCode = await runAttached({
          namespace,
          kindId: BUILD_RUN_KIND_ID,
          runId: buildId,
          argv: [
            process.execPath,
            resolve(process.argv[1] ?? ""),
            ...buildArgs,
          ],
          cwd: root,
          env,
        });
      }
      exitCode = deadBuildExitCode(exitCode, {
        atStart: oomKillsAtStart,
        atEnd: await readOomKills(),
      });
      // The build closes its own row on every verdict; this is the backstop for
      // the ways it can end without one (a throw, an early exit, a signal), so
      // the next decision sees this attempt. First writer wins.
      if (claim === "claimed") await recorder.closeRun(buildId, exitCode);
      built = true;
      ranHere.add(buildId);
      for (const t of targets) builtHere.add(`${head40} ${t}`);
      log(`build ${buildId} exited ${exitCode}${describeExit(exitCode)}`);
      // No ledger to record the attempt in, so the ledger cannot end the loop:
      // one build, then stop. The next edge decides against the ledger this
      // build created.
      if (claim === "unavailable" || decision.ledger === "missing") return 0;
    }
  } finally {
    await recorder.close();
  }
}

/** What a build's exit code says, in the status words its run badge uses. */
function describeExit(exitCode: number): string {
  const status = buildStatusOf({ finishedAt: new Date(), exitCode });
  switch (status) {
    case "success":
    case "running":
      return "";
    case "failed":
      return " (failed)";
    case "killed":
      return ` (killed: ${killedSignalName(exitCode)} — not a verdict on the code)`;
    case "out-of-memory":
      return " (out of memory: the host's OOM killer took the build or a step — not a verdict on the code)";
    case "interrupted":
    case "superseded":
      return ` (${status} — not a verdict on the code)`;
  }
}

function slotSha(head: string | null): string {
  if (head === null) {
    throw new Error(
      "[converge] main wants a build, but git named no commit to build — no slot can be checked out",
    );
  }
  return head;
}

/**
 * One main build in a slot: a slot checked out at `sha` and handed to
 * `<slot>/equin build …`, run there as the attached supervised run `buildId`
 * (`runInBuildSlot`: the child holds the slot — exclusively, then shared once
 * it hands it to the backend it restarts there — until it exits). The
 * `<slot>/equin` wrapper rather than this process's Bun: the slot's commit
 * may pin another toolchain.
 */
async function buildInSlot(i: {
  sha: string;
  repoRoot: AppPath;
  namespace: Namespace;
  buildId: string;
  buildArgs: string[];
  env: Record<string, string | undefined>;
  log: (line: string) => void;
}): Promise<number> {
  const startedAt = Date.now();
  return runInBuildSlot(
    i.sha,
    { repoRoot: i.repoRoot, label: i.buildId },
    async ({ slot, created, env }) => {
      i.log(
        `slot ${slot} at ${i.sha.slice(0, 9)} (${created ? "made" : "reused"}, ${Date.now() - startedAt} ms)`,
      );
      return runAttached({
        namespace: i.namespace,
        kindId: BUILD_RUN_KIND_ID,
        runId: i.buildId,
        argv: [joinAppPath(slot, CLI_NAME), ...i.buildArgs],
        cwd: slot,
        env: { ...i.env, ...env },
      });
    },
  );
}
