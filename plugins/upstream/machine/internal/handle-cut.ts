import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  CUT_REFUSED_EXIT_CODE,
  cutReleaseEndpoint,
} from "@plugins/upstream/plugins/release/core";

/**
 * One fetch of the publish remote and one tag push, the cut's own bounds
 * (`version/cli/cut.ts`) plus room for the CLI to start.
 */
const CUT_TIMEOUT_MS = 10 * 60_000;

/**
 * `POST /api/upstream/release`: `./equin version cut`, in this backend's
 * checkout. The CLI IS the implementation — the button runs it rather than a
 * second copy of its checks, so the two can never disagree about what may be
 * released. On a worktree's backend the CLI refuses (a release is cut from
 * main's checkout), and that refusal is what the page shows.
 *
 * A refusal is the CLI's `CUT_REFUSED_EXIT_CODE` with its reason on stderr;
 * anything else (a crash — exit 1 —, killed, timed out) is a failure of the
 * cut itself, thrown, so the endpoint answers 5xx and the failure is filed as
 * a report an agent can investigate, not only toasted.
 */
export const handleCutRelease = implementMachine(
  cutReleaseEndpoint,
  async () => {
    const argv = [`./${CLI_NAME}`, "version", "cut"];
    const r = await spawnCaptured(argv, {
      cwd: REPO_ROOT,
      timeoutMs: CUT_TIMEOUT_MS,
    });
    if (r.timedOut)
      throw new Error(
        `\`${argv.join(" ")}\` did not finish in ${CUT_TIMEOUT_MS / 60_000} min.\n${r.stderr.trim()}`,
      );
    if (r.exitCode === 0)
      return { kind: "released", detail: lastLine(r.stdout) };
    if (r.exitCode === CUT_REFUSED_EXIT_CODE)
      return { kind: "refused", detail: r.stderr.trim() };
    throw new Error(
      `\`${argv.join(" ")}\` exited ${r.exitCode}${r.signalCode === null ? "" : ` (${r.signalCode})`}.\n${r.stderr.trim()}`,
    );
  },
);

function lastLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .at(-1) ?? ""
  );
}
