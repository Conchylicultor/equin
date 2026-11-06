import {
  installFatalSignalExit,
  runCheckSubprocess,
  signalOriginTap,
} from "@plugins/framework/plugins/cli/plugins/op-runtime/cli";
import { normalizeGeneratedArtifacts } from "@plugins/framework/plugins/cli/plugins/git-artifacts/cli";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { inheritedGrant } from "@plugins/infra/plugins/host/plugins/host-admission/server";
import type { Grant } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { resolvePublishTarget } from "@plugins/infra/plugins/git/plugins/remotes/core";
import { withTreeWrite } from "@plugins/infra/plugins/git/plugins/tree-lock/core";
import { checkoutNamespace } from "@plugins/infra/plugins/paths/server";
import {
  exec,
  execPublish,
  getMainWorktree,
  getWorktreeRoot,
  publishMain,
  run,
} from "./git";
import { openLandReport, type LandPayload, type LandReporter } from "./handoff";

// The LAND PHASE of a push: everything after the rebase, run by the push driver
// (`./run.ts`) as a child on the REBASED code, inside the driver's mutex and
// grant — see `./handoff.ts` for why it is a separate process.
//
// It is nested, like a check run under a build: no op record, no worktree-op
// marker, no mutex request of its own — the driver holds all three and records
// this phase's steps from its report. What it knows is re-derived from git where
// it can be (branch, checkout, main's worktree, the publish target); only the
// push id and the report path are handed over.

const CHECKS_FAILED_ADVICE =
  `If the failure is unrelated to your commits (e.g. a pre-existing issue on main), ` +
  `try rebasing onto the latest main (\`git fetch origin main && git rebase origin/main\`) and re-running — the issue may already be fixed upstream.\n\n` +
  `If you cannot fix the failing check(s): STOP, report the failure to the user, and wait for instructions. ` +
  `Do NOT work around check failures — not by disabling checks, editing check code, ` +
  `expanding skip lists, committing via raw git, or any other means.`;

export async function landPush(payload: LandPayload): Promise<void> {
  // Refuse to run outside a push: the payload is set only by a driver inside
  // its mutex, and that driver always hands its grant down with it.
  const grant = inheritedGrant();
  if (grant === undefined) {
    throw new Error(
      "push: a land phase runs only under the push that spawned it (the hand-off " +
        "came without its host grant). Run ./equin push.",
    );
  }
  const root = await getWorktreeRoot();
  // A killed land phase leaves the same record a killed push does: who sent the
  // signal, under the push's op id.
  installFatalSignalExit(
    await signalOriginTap({
      opId: payload.pushId,
      worktree: await checkoutNamespace(root),
    }),
  );
  const report = openLandReport(payload.report);

  if (payload.mode === "from-main")
    await landFromMain(root, payload.pushId, grant, report);
  else await landWorktree(root, payload.pushId, grant, report);
  report.complete("success");
}

// Post-rebase normalize: regenerate the generated artifacts (docs, drizzle
// migrations) from the rebased source tree and amend the head commit. The merge
// drivers in .gitattributes took the upstream side during the rebase; this makes
// the final commit canonical. Aborts on hand-edited migrations or on real
// conflict markers in CLAUDE.md prose.
//
// `force` — regenerate whether or not a merge marker reached us. A missing marker
// is supposed to mean "the drivers never fired", but it is equally what a marker
// written where nobody reads it looks like, and the two cost wildly different
// amounts to confuse: the commit that lands on main is checked right after, and
// for a branch that edits a doc GENERATOR the upstream side the drivers took is
// wrong for the sources git just merged. Push already runs for minutes, so it
// buys the certainty; the `post-rewrite` hook, which fires after every rebase
// anyone does, stays marker-gated.
//
// Its install half — the lockfile the rebase brought in — already ran: this
// process's own bootstrap installed it, frozen, before any of this code loaded.
async function normalize(
  root: AppPath,
  pushId: string,
  report: LandReporter,
): Promise<void> {
  report.stepStart("normalize");
  await normalizeGeneratedArtifacts(root, { pushId, force: true });
  report.stepEnd("normalize");
}

// Run the rebased-tree checks under the push's grant — handed down by the
// driver, which holds it for the whole critical section. The spawn itself is
// `op-runtime`'s check-subprocess (read its docblock for why a check pass is a
// separate process and why the selection is a flag). `--scope tree` narrows the
// pass to the push payload (see `Check.scope`): deploy-scoped checks verify the
// local gitignored dist that `build` produces, which never lands on main and
// which this push's own rebase moves the tree past by construction.
async function runRebasedChecks(
  root: AppPath,
  grant: Grant,
  report: LandReporter,
): Promise<boolean> {
  report.stepStart("checks");
  console.log("Running checks...");
  const result = await runCheckSubprocess({
    root,
    grant,
    select: { scope: "tree" },
    output: "inherit",
  });
  report.stepEnd("checks");
  return result.ok;
}

function failChecks(report: LandReporter, message: string): never {
  console.error(`${message}\n\n${CHECKS_FAILED_ADVICE}`);
  report.complete("failed_checks");
  process.exit(1);
}

async function currentBranch(): Promise<string> {
  return run(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
}

async function landWorktree(
  root: AppPath,
  pushId: string,
  grant: Grant,
  report: LandReporter,
): Promise<void> {
  const branch = await currentBranch();
  const mainWorktree = await getMainWorktree(root);
  const publish = await resolvePublishTarget(root);

  await normalize(root, pushId, report);

  // 4. Run checks on the rebased tree — exactly what will land on main, and the
  //    pass is scoped to exactly that (`--scope tree`).
  if (!(await runRebasedChecks(root, grant, report))) {
    failChecks(
      report,
      `Checks failed after rebasing ${branch} onto main. ` +
        `Fix the issue and re-run ./equin push ` +
        `(your commits are on ${branch}; use \`git reset --soft HEAD~1\` to unstage the last one if needed).`,
    );
  }

  // 5. Push the branch (force since rebase rewrites history — safe for
  //    single-owner worktree branches). Skipped in local mode: the branch has
  //    nowhere to go, and step 7 below is what the work is for.
  if (publish.kind === "publish") {
    report.stepStart("push-branch");
    console.log(`Pushing branch ${branch}...`);
    await execPublish(
      ["git", "push", "--force-with-lease", "-u", publish.remote, branch],
      undefined,
      root,
    );
    report.stepEnd("push-branch");
  }

  // 6. Publish the branch as the remote's main — BEFORE local main moves
  //    (publishMain says why). Skipped in local mode, where local main is the
  //    trunk and step 7 is the whole landing.
  if (publish.kind === "publish") {
    report.stepStart("push-main");
    console.log("Pushing main...");
    await publishMain(publish.remote, branch, root);
    report.stepEnd("push-main");
  }

  // 7. Fast-forward local main (guaranteed to succeed — the driver holds the
  //    mutex, so no other push can have advanced it since our rebase). The last
  //    step: main's own auto-build takes it from there.
  report.stepStart("ff-merge");
  console.log(`Merging ${branch} into main...`);
  //    Under main's tree write lock (`infra/git/tree-lock`): the merge rewrites
  //    main's files one by one, and every supervised child on main boots its
  //    plugin graph out of this tree — one loading mid-merge reads two commits
  //    at once (2026-11-05: `worktree.prepare` and `database.fork` died on an
  //    export the half-written tree lacked). Remote main already moved (step 6),
  //    so a failure here leaves local main behind it — say so, with the one
  //    command that finishes it.
  await withTreeWrite(mainWorktree, () =>
    exec(["git", "merge", "--ff-only", branch], mainWorktree),
  ).catch((err: unknown) => {
    throw new Error(
      `${branch} is pushed${publish.kind === "publish" ? " and remote main already points at it" : ""}, ` +
        `but local main was not fast-forwarded. Finish it: git -C ${mainWorktree} merge --ff-only ${branch}`,
      { cause: err },
    );
  });
  report.stepEnd("ff-merge");

  console.log(
    publish.kind === "publish"
      ? `Done. ${branch} merged into main and pushed.`
      : `Done. ${branch} merged into local main. Nothing was pushed.`,
  );
}

async function landFromMain(
  root: AppPath,
  pushId: string,
  grant: Grant,
  report: LandReporter,
): Promise<void> {
  const publish = await resolvePublishTarget(root);

  await normalize(root, pushId, report);

  if (!(await runRebasedChecks(root, grant, report))) {
    failChecks(
      report,
      "Checks failed after rebase. Fix the issue and re-run ./equin push " +
        "(your commit is still on HEAD; use `git reset --soft HEAD~1` to unstage it if needed).",
    );
  }

  if (publish.kind === "publish") {
    report.stepStart("push-main");
    console.log("Pushing main...");
    await execPublish(["git", "push"], undefined, root);
    report.stepEnd("push-main");
  }

  console.log(
    publish.kind === "publish"
      ? "Done. Pushed directly from main."
      : "Done. Committed directly on local main. Nothing was pushed.",
  );
}
