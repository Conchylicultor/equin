import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { fetchUpstreamStatus } from "@plugins/upstream/core";
import { releaseVersion } from "@plugins/upstream/plugins/release/core";
import { noUpstreamSentence } from "./internal/describe";

/**
 * `./equin upstream status` — whether upstream has cut a release local `main`
 * does not hold.
 *
 * Read-only: it fetches upstream's main and release tags (otherwise the answer
 * would be as old as the last fetch) and touches nothing else.
 *
 * "There is no upstream" and "you are up to date" are answers, so they exit 0.
 * Not being able to REACH upstream is not an answer, so it exits 1 — but in
 * plain words, with no stack and no crash record. A laptop on a train is not an
 * incident.
 */
const run: CliAction<[], object> = async () => {
  const status = await fetchUpstreamStatus(await getWorktreeRoot());

  if (status.kind === "no-upstream") {
    console.log(noUpstreamSentence(status.reason));
    return;
  }
  if (status.kind === "unreachable") {
    console.error(
      `Could not reach ${status.remote} (${status.url}).\n` +
        `  ${status.detail}\n\n` +
        `Nothing was read, so this says nothing about whether there are updates. Try again when you can reach it.`,
    );
    process.exit(1);
  }
  if (status.kind === "no-release") {
    console.log(
      `${status.remote} (${status.url}) has cut no release yet — there is nothing to update to.`,
    );
    return;
  }
  if (status.kind === "current") {
    console.log(
      `Up to date: main holds ${status.remote}'s newest release, ${releaseVersion(status.release)} (${status.url}).`,
    );
    return;
  }

  console.log(
    `${status.remote} has released ${releaseVersion(status.latest)}; main is on ${status.current === null ? "no release" : releaseVersion(status.current)} (${status.url}).`,
  );
  console.log(`\nRun \`./equin upstream merge\` in a worktree to bring it in.`);
};

export default run;
