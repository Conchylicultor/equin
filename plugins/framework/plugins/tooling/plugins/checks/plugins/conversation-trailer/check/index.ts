import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  envName,
  readEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import {
  ATTEMPT_TRAILER_KEY,
  CONVERSATION_TRAILER_KEY,
  UNATTRIBUTED_TRAILER_KEY,
  attemptOfBranch,
} from "@plugins/tasks/plugins/tasks-core/core";

const TRAILER = CONVERSATION_TRAILER_KEY;

// Wedge-breaker for a metadata-only git read: far above any real duration,
// because starvation under a saturated check run is what these suffer, not
// slowness. Same reasoning as `infra/worktree`'s bounds, which carry the
// measurements.
const GIT_TIMEOUT_MS = 60_000;

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = {
  id: string;
  description: string;
  run(): Promise<CheckResult>;
  cacheSignature?(): string | null;
};

const STOP_MESSAGE =
  "STOP. Do not attempt to fix, commit, or push. Report this failure to the user verbatim and wait for explicit instructions before starting a debugging session.";

async function run(
  cmd: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const result = await spawnCaptured(cmd, { timeoutMs: GIT_TIMEOUT_MS });
  return { stdout: result.stdout.trim(), exitCode: result.exitCode };
}

async function currentBranch(): Promise<string> {
  const { stdout } = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
  return stdout;
}

// This branch's own commits: reachable from HEAD and from no `main` this
// checkout knows of — local `main` or any `refs/remotes/<remote>/main` (the
// published set, as `database/migrations`' `publishedMigrationRefs` reads it).
// After `./equin upstream merge` a clone's branch carries upstream's
// commits, which sit on `<remote>/main` and not on local `main`: they were
// authored in upstream's own sessions (or none), so their trailers are not
// this pane's to have, and asking would fail every upstream update's push.
interface OwnCommit {
  sha: string;
  /** The conversation trailer's value(s), comma-joined; "" when absent. */
  trailer: string;
  /** Carries an attempt or an unattributed trailer. */
  namedOtherwise: boolean;
}

async function commitsAheadOfMain(): Promise<OwnCommit[]> {
  const { stdout, exitCode } = await run([
    "git",
    "log",
    "HEAD",
    "--not",
    "main",
    "--glob=refs/remotes/*/main",
    `--format=%H%x00%(trailers:key=${TRAILER},valueonly,separator=%x2C)%x00%(trailers:key=${ATTEMPT_TRAILER_KEY},valueonly,separator=%x2C)%(trailers:key=${UNATTRIBUTED_TRAILER_KEY},valueonly,separator=%x2C)`,
  ]);
  if (exitCode !== 0 || !stdout) return [];
  return stdout.split("\n").map((line) => {
    const parts = line.split("\0");
    return {
      sha: parts[0]!,
      trailer: (parts[1] ?? "").trim(),
      namedOtherwise: (parts[2] ?? "").trim() !== "",
    };
  });
}

// A commit whose message names the trailer key OUTSIDE the trailer block (the
// last paragraph — the only place %(trailers) reads). Distinct cause from "no
// trailer at all": the hook fired, but the line ended up in the body.
async function hasStrayBodyTrailer(sha: string): Promise<boolean> {
  const { stdout } = await run(["git", "show", "-s", "--format=%B", sha]);
  return new RegExp(`^${TRAILER}:`, "m").test(stdout);
}

const check: Check = {
  id: "conversation-trailer",
  description: `every commit ahead of every known main (local, and each <remote>/main) is attributable: with ${envName("CONVERSATION_ID")} set it carries that conversation's ${TRAILER} trailer; without it the branch is an attempt's (push credits it with ${ATTEMPT_TRAILER_KEY}) or each commit names its conversation, attempt or ${UNATTRIBUTED_TRAILER_KEY} reason`,
  // Not a pure function of the working tree: reads EQUIN_CONVERSATION_ID
  // env and the trailers of this branch's own commits. Never cache.
  cacheSignature: () => null,
  async run() {
    const branch = await currentBranch();
    if (branch === "main") return { ok: true };

    const envId = readEnv("CONVERSATION_ID");
    const commits = await commitsAheadOfMain();
    if (!envId) {
      // A session equin did not launch (a plain terminal, e.g. recovering a
      // broken main): there is no conversation to vouch for. An attempt's
      // branch still names who the push credits — push stamps the attempt
      // trailer from it on every commit it lands.
      if (attemptOfBranch(branch)) return { ok: true };
      const unnamed = commits.filter((c) => !c.trailer && !c.namedOtherwise);
      if (unnamed.length === 0) return { ok: true };
      const list = unnamed.map((c) => `  ${c.sha.slice(0, 12)}`).join("\n");
      return {
        ok: false,
        message:
          `${envName("CONVERSATION_ID")} is not set (this session was not launched by equin) and ${branch} is no attempt's branch, ` +
          `so nothing names who these ${unnamed.length} commit(s) ahead of main are for:\n${list}`,
        hint:
          "Ask the user before landing it unattributed; with their approval in this conversation, push with " +
          '`./equin push --unattributed "<one-line reason>"`, which records the reason in the commit instead. ' +
          "Do not set the env var by hand to another conversation's id.",
      };
    }

    if (commits.length === 0) return { ok: true };

    const missing = commits.filter((c) => !c.trailer);
    if (missing.length > 0) {
      const stray = new Set<string>();
      for (const c of missing) {
        if (await hasStrayBodyTrailer(c.sha)) stray.add(c.sha);
      }
      const absent = missing.filter((c) => !stray.has(c.sha));
      const parts: string[] = [];
      if (absent.length > 0) {
        const list = absent.map((c) => `  ${c.sha.slice(0, 12)}`).join("\n");
        parts.push(
          `${absent.length} commit(s) ahead of main lack a ${TRAILER} trailer:\n${list}\n` +
            `The prepare-commit-msg hook did not fire for these commits (env missing at commit time, or committed from outside the pane).`,
        );
      }
      if (stray.size > 0) {
        const list = [...stray]
          .map((sha) => `  ${sha.slice(0, 12)}`)
          .join("\n");
        parts.push(
          `${stray.size} commit(s) ahead of main carry a ${TRAILER} line in the message BODY, not in the trailer block (the last paragraph), so git does not read it as a trailer:\n${list}\n` +
            `Typically a reused commit message with text appended after its trailers.`,
        );
      }
      return {
        ok: false,
        message:
          parts.join("\n") +
          `\nWithout the trailer, the pushes ledger cannot attribute the push and the task will stay 'attempted'.`,
        hint: STOP_MESSAGE,
      };
    }

    const mismatched = commits.filter(
      (c) => c.trailer && !c.trailer.split(",").includes(envId),
    );
    if (mismatched.length > 0) {
      const list = mismatched
        .map((c) => `  ${c.sha.slice(0, 12)}  trailer=${c.trailer}`)
        .join("\n");
      return {
        ok: false,
        message: `${mismatched.length} commit(s) carry a ${TRAILER} trailer that does not match this pane (${envName("CONVERSATION_ID")}=${envId}):\n${list}`,
        hint:
          "If the commit was created by another conversation sharing this worktree, " +
          "you can safely uncommit (git reset HEAD~1) while keeping the changes, " +
          "then run ./equin push again — the new commit will carry the correct trailer for this conversation. " +
          STOP_MESSAGE,
      };
    }

    return { ok: true };
  },
};

export default check;
