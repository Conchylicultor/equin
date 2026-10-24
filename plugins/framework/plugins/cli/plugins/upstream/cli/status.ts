import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { fetchUpstreamStatus } from "@plugins/upstream/core";
import { noUpstreamSentence } from "./internal/describe";

/**
 * `./equin upstream status` — what upstream has that you do not.
 *
 * Read-only: it fetches (otherwise the count would be measured against however
 * old the remote-tracking ref on disk happens to be) and touches nothing else.
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
  if (status.kind === "current") {
    console.log(`Up to date with ${status.ref} (${status.url}).`);
    return;
  }

  const plural = status.count === 1 ? "" : "s";
  console.log(
    `${status.count} commit${plural} on ${status.ref} that main does not have (${status.url}):\n`,
  );
  for (const c of status.newest)
    console.log(`  ${c.sha.slice(0, 9)}  ${c.subject}`);
  const shown = status.newest.length;
  if (shown < status.count)
    console.log(`  … and ${status.count - shown} older`);

  console.log(
    `\nRun \`./equin upstream merge\` in a worktree to bring them in.`,
  );
};

export default run;
