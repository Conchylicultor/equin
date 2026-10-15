import type { LiveRowsCollection } from "@plugins/network/plugins/live/core";
import { Investigate } from "@plugins/primitives/plugins/launch/plugins/investigate/web";
import {
  RELEASE_CATEGORY_ID,
  RELEASE_LOG_CHANNEL,
  RELEASE_RUN_KIND,
  releaseHistory,
} from "@plugins/release/core";
import { runSubject } from "@plugins/runs/core";

type ReleaseHistoryRow =
  typeof releaseHistory extends LiveRowsCollection<infer R> ? R : never;

/**
 * A failed release's Investigate action, in every list of a composition's
 * release history — filed about the same subject as the merged runs list's
 * release row, so the two reach one task.
 */
export const investigateReleaseHistory =
  Investigate.Register<ReleaseHistoryRow>({
    owner: releaseHistory,
    failed: (run) => run.status === "failed",
    noun: "release",
    categoryId: RELEASE_CATEGORY_ID,
    subject: (run) => runSubject({ kind: RELEASE_RUN_KIND, id: run.id }),
    description: (run) =>
      `Launch an agent briefed on this failed ${run.target} release of ${run.composition} — its error verbatim, its provenance, and where the transcript is.`,
    brief: (run, userText) => {
      const extra = userText.trim();
      return [
        "## Investigate a failed release",
        "",
        `A \`${run.kind}\` release of composition \`${run.composition}\` for target \`${run.target}\` failed.`,
        "",
        "**The run**",
        "",
        `- release run id: \`${run.id}\` (a row in \`release_runs\`)`,
        `- platform: ${run.platform ?? "host"}`,
        `- started: ${run.startedAt.toISOString()}`,
        `- finished: ${run.finishedAt ? run.finishedAt.toISOString() : "never recorded"}`,
        `- exit code: ${run.exitCode ?? "none reported"}`,
        `- commit: ${run.commitSha ? `\`${run.commitSha}\`${run.commitDirty ? " (dirty tree)" : ""}` : "unknown"}`,
        "",
        ...(run.error
          ? ["**The error**, verbatim:", "", "```", run.error, "```", ""]
          : ["The run recorded no error.", ""]),
        "**Where to dig**",
        "",
        `- the transcript: the \`${RELEASE_LOG_CHANNEL}\` log channel, and the release run-detail pane (Studio → this composition → Release history → this run);`,
        `- the ledger row: \`select * from release_runs where id = '${run.id}'\` via \`query_db\`;`,
        "- `./singularity release` is the engine — a failed bundle is the CLI's verdict, so a wrong one is a CLI or code bug, not a UI one.",
        "",
        "Find the root cause and say what it is. Fix it if the fix is clearly in this repo.",
        ...(extra ? ["", "## What the user asked for", "", extra] : []),
      ].join("\n");
    },
  });
