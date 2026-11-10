import { resolve } from "node:path";
import { z } from "zod";
import { callEndpoint } from "@plugins/infra/plugins/endpoints/server";
import { EndpointError } from "@plugins/infra/plugins/endpoints/core";
import { adaptiveTimeoutMs } from "@plugins/framework/plugins/cli/plugins/bootstrap/cli";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import {
  getMainRepoRoot,
  getWorktreeRoot,
} from "@plugins/infra/plugins/spawn/core";
import {
  fileReportFromProcess,
  mergeBaseWithMain,
} from "@plugins/reports/plugins/outbox/core";
import {
  CANNOT_JUDGE_REPORT_KIND,
  type adoptCentralDeploy,
  type adoptDeploy,
  type AdoptVerdict,
  type CannotJudgePayload,
} from "@plugins/build/plugins/restart-skip/core";

/**
 * Ask a running backend (or central) to adopt this deploy instead of being
 * restarted for it (`build/restart-skip`). The process judges — only it knows
 * what it loaded; this side only says what the spec it is about to be
 * restarted under spawns. Fails toward restart: no command to compare (the
 * gateway's default Bun), no commit to pin, nothing answering, or a process
 * too old to know the route — each is `restart` with its reason.
 *
 * A `cannot-judge` answer restarts too, and main's build also files it as a
 * `restart-skip-cannot-judge` report (through the outbox: this is a CLI
 * process) — the judgement could not measure the code, so restart-skip is
 * off for every deploy until that is fixed, and a quiet log line in each
 * build is how it went unnoticed for 19 of 39 main deploys. A worktree's
 * build only prints it: its own unmerged code is not main's problem, and
 * `boot:closure-digestable` already fails that build's checks on the same
 * refusal.
 */
export async function askAdoption(opts: {
  endpoint: typeof adoptDeploy | typeof adoptCentralDeploy;
  /** Who is asked — a namespace's backend, or central — named in the report a `cannot-judge` files. */
  asked: Pick<CannotJudgePayload, "process" | "namespace">;
  /** Where the process is reached: its namespace's URL, or the gateway for central. */
  origin: string;
  /** The spec's `server` dir, which the command's entry is relative to. */
  server: string;
  /** The spec's `command`, as just written. */
  command: string[] | undefined;
  commit: string | null;
}): Promise<AdoptVerdict> {
  const { command, commit } = opts;
  if (command === undefined) {
    return {
      kind: "restart",
      reason: "the spec runs the gateway's default Bun",
    };
  }
  if (commit === null) {
    return { kind: "restart", reason: "this build has no commit to pin" };
  }
  const [bin, entry] = command;
  if (bin === undefined || entry === undefined) {
    return {
      kind: "restart",
      reason: `the spec's command is not [bun, entry]: ${JSON.stringify(command)}`,
    };
  }
  let verdict: AdoptVerdict;
  try {
    verdict = await callEndpoint(
      opts.endpoint,
      {},
      {
        origin: opts.origin,
        body: { bin, entry: resolve(opts.server, entry), commit },
        signal: AbortSignal.timeout(adaptiveTimeoutMs(30_000, 120_000)),
      },
    );
  } catch (err) {
    // Nothing serving (TypeError), no answer in time (DOMException), a
    // process that predates the route or is still booting (a non-2xx), or a
    // reply this checkout's contract rejects (ZodError): none vouches for the
    // running code. Anything else is unexpected — rethrow.
    if (
      !(err instanceof TypeError) &&
      !(err instanceof DOMException) &&
      !(err instanceof EndpointError) &&
      !(err instanceof z.ZodError)
    )
      throw err;
    return {
      kind: "restart",
      reason: `no answer to the adopt request (${err instanceof EndpointError ? `HTTP ${err.status}` : err.message})`,
    };
  }
  if (verdict.kind === "cannot-judge") {
    await reportCannotJudge({ ...opts.asked, reason: verdict.reason });
  }
  return verdict;
}

// The code a cannot-judge report is about: the judgement and the closure walk
// it rests on. A writer on a branch point main has since changed them at is
// dropped by the drain (main may already have fixed it).
const JUDGEMENT_PATHS = [
  "plugins/build/plugins/restart-skip",
  "plugins/packages/plugins/source-digest",
];

async function reportCannotJudge(data: CannotJudgePayload): Promise<void> {
  const who =
    data.namespace === null ? "central" : `the ${data.namespace} backend`;
  const message = `${who} cannot judge whether a deploy changes its code, so it restarts on every deploy: ${data.reason}`;
  // The same test the build uses for "this is main" (`run.ts`'s central step).
  if ((await getWorktreeRoot()) !== (await getMainRepoRoot())) {
    console.error(
      `Restart-skip cannot judge (not reported: a worktree build): ${message}`,
    );
    return;
  }
  const mergeBase = await mergeBaseWithMain(REPO_ROOT);
  const filed = await fileReportFromProcess({
    kind: CANNOT_JUDGE_REPORT_KIND,
    message,
    data,
    ...(mergeBase.ok
      ? { code: { mergeBase: mergeBase.mergeBase, paths: JUDGEMENT_PATHS } }
      : {}),
  });
  if (filed.outcome === "written") {
    console.error(`Filed a ${CANNOT_JUDGE_REPORT_KIND} report: ${message}`);
  } else {
    // `fileReportFromProcess` already printed why.
    console.error(
      `Could not file the ${CANNOT_JUDGE_REPORT_KIND} report: ${message}`,
    );
  }
}
