import type { ReactElement } from "react";
import { InvestigateAction } from "@plugins/primitives/plugins/launch/plugins/investigate/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { DEPLOY_CATEGORY_ID } from "@plugins/apps/plugins/deploy/core";
import {
  DEPLOY_LOG_CHANNEL,
  type DeployRunRecord,
} from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { DEPLOY_RUN_KIND } from "@plugins/apps/plugins/deploy/plugins/deployments/plugins/runs-arm/core";
import { runSubject } from "@plugins/runs/core";

/**
 * How this run died, in the same honest words the live failure notice uses: a
 * null exit code means no CLI process reported one, so for a multi-leg `update`
 * the PHASE is what happened, and only a phase-less run can be called "never
 * started".
 */
function failureSentence(run: DeployRunRecord): string {
  if (run.exitCode !== null) return `exited ${run.exitCode}`;
  if (run.phaseFailed)
    return `died during its ${run.phaseFailed} leg without an exit code`;
  return "never started — no process reported an exit code";
}

/**
 * The brief an investigating agent gets: every fact this row already holds,
 * plus where to go for the parts it does not.
 *
 * It states facts and pointers, not a diagnosis. The CLI owns every refusal in
 * this domain, so its own words (`message`) are quoted verbatim and nothing
 * around them is summarised or reinterpreted — the same rule the row itself
 * follows.
 */
function brief(run: DeployRunRecord, userText: string): string {
  const body = userText.trim();
  return [
    `## Investigate a failed deploy`,
    "",
    `A \`${run.verb}\` of composition \`${run.compositionId}\` onto server`,
    `\`${run.serverId}\` failed: it ${failureSentence(run)}.`,
    "",
    "**The run**",
    "",
    `- deploy run id: \`${run.id}\` (a row in the \`deploy_runs\` table)`,
    `- deployment id: \`${run.deploymentId}\``,
    `- verb: \`${run.verb}\`${run.phaseFailed ? ` — failed on the \`${run.phaseFailed}\` leg` : ""}`,
    `- exit code: ${run.exitCode ?? "none reported"}`,
    `- started: ${run.startedAt.toISOString()}`,
    `- finished: ${run.finishedAt ? run.finishedAt.toISOString() : "never (no terminal status was recorded)"}`,
    `- pinned release run: ${run.releaseRunId ? `\`${run.releaseRunId}\`` : "none — the CLI picked the bundle itself"}`,
    `- commit shipped: ${run.commitSha ? `\`${run.commitSha}\`` : "unknown — nothing pinned a bundle, so this app never saw which one went out"}`,
    "",
    ...(run.message
      ? ["**What the CLI said**, verbatim:", "", "```", run.message, "```", ""]
      : [
          "The run recorded no message, so the transcript is the only account of it.",
          "",
        ]),
    "**Where to dig**",
    "",
    `- the whole transcript is in the \`${DEPLOY_LOG_CHANNEL}\` log channel; each run is`,
    "  prefixed by its own argv line, so find this run's spawn and read forward from it;",
    `- the ledger row itself (\`select * from deploy_runs where id = '${run.id}'\`) via \`query_db\`;`,
    "- `./singularity deploy` is the engine — every refusal, host mutation and health",
    "  gate is the CLI's, and the app only launches it. So a wrong verdict is a CLI or",
    "  host-state bug, not a UI one;",
    "- the deployment pane at Deploy → this server → this deployment shows the record,",
    "  its derived install and the output panel.",
    "",
    "Find the root cause and say what it is. Fix it if the fix is clearly in this repo;",
    "if it is host state on the remote box, say exactly what is wrong there and what",
    "would repair it — do not touch a remote host without being asked.",
    ...(body ? ["", "## What the user asked for", "", body] : []),
  ].join("\n");
}

/**
 * One row action on the History list, rendered only on a run that failed.
 *
 * A succeeded run has nothing to investigate and a `running` one has not
 * finished having its outcome — so the gate is `status === "failed"` and not
 * "not succeeded". A permanently-`running` row (its backend died mid-run) is
 * deliberately not offered this: the ledger never observed a failure there, and
 * briefing an agent that one happened would be inventing the outcome the row
 * itself refuses to invent.
 */
export function InvestigateFailureAction({
  row,
}: ItemActionProps<DeployRunRecord>): ReactElement | null {
  if (row.status !== "failed") return null;

  // The same subject the merged runs list files a failed deploy under, so the
  // two reach one task.
  return (
    <InvestigateAction
      presentation="row-action"
      noun={row.verb}
      subject={runSubject({ kind: DEPLOY_RUN_KIND, id: row.id })}
      categoryId={DEPLOY_CATEGORY_ID}
      description={`Launch an agent briefed on this failed ${row.verb} of ${row.compositionId} — the CLI's own message, the run's identity, and where the transcript is.`}
      brief={(userText) => brief(row, userText)}
    />
  );
}
