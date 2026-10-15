import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";

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

async function commitsAheadOfMain(): Promise<
  { sha: string; trailer: string }[]
> {
  const { stdout, exitCode } = await run([
    "git",
    "log",
    "main..HEAD",
    "--format=%H%x00%(trailers:key=Singularity-Conversation,valueonly,separator=%x2C)",
  ]);
  if (exitCode !== 0 || !stdout) return [];
  return stdout.split("\n").map((line) => {
    const parts = line.split("\0");
    return { sha: parts[0]!, trailer: (parts[1] ?? "").trim() };
  });
}

// A commit whose message names the trailer key OUTSIDE the trailer block (the
// last paragraph — the only place %(trailers) reads). Distinct cause from "no
// trailer at all": the hook fired, but the line ended up in the body.
async function hasStrayBodyTrailer(sha: string): Promise<boolean> {
  const { stdout } = await run(["git", "show", "-s", "--format=%B", sha]);
  return /^Singularity-Conversation:/m.test(stdout);
}

const check: Check = {
  id: "conversation-trailer",
  description:
    "SINGULARITY_CONVERSATION_ID is set and every commit ahead of main carries the Singularity-Conversation trailer",
  // Not a pure function of the working tree: reads SINGULARITY_CONVERSATION_ID
  // env and `git log main..HEAD` trailers. Never cache.
  cacheSignature: () => null,
  async run() {
    const branch = await currentBranch();
    if (branch === "main") return { ok: true };

    const envId = process.env.SINGULARITY_CONVERSATION_ID;
    if (!envId) {
      return {
        ok: false,
        message:
          "SINGULARITY_CONVERSATION_ID is not set in this shell. The `./singularity push` amend would strip attribution, orphaning the push from its task.",
        hint: STOP_MESSAGE,
      };
    }

    const commits = await commitsAheadOfMain();
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
          `${absent.length} commit(s) ahead of main lack a Singularity-Conversation trailer:\n${list}\n` +
            `The prepare-commit-msg hook did not fire for these commits (env missing at commit time, or committed from outside the pane).`,
        );
      }
      if (stray.size > 0) {
        const list = [...stray]
          .map((sha) => `  ${sha.slice(0, 12)}`)
          .join("\n");
        parts.push(
          `${stray.size} commit(s) ahead of main carry a Singularity-Conversation line in the message BODY, not in the trailer block (the last paragraph), so git does not read it as a trailer:\n${list}\n` +
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
        message: `${mismatched.length} commit(s) carry a Singularity-Conversation trailer that does not match this pane (SINGULARITY_CONVERSATION_ID=${envId}):\n${list}`,
        hint:
          "If the commit was created by another conversation sharing this worktree, " +
          "you can safely uncommit (git reset HEAD~1) while keeping the changes, " +
          "then run ./singularity push again — the new commit will carry the correct trailer for this conversation. " +
          STOP_MESSAGE,
      };
    }

    return { ok: true };
  },
};

export default check;
