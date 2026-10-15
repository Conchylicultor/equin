import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { InvestigateAction } from "@plugins/primitives/plugins/launch/plugins/investigate/web";
import type { EntryRun } from "@plugins/infra/plugins/background/plugins/catalog/web";
import { BACKGROUND_CATEGORY_ID } from "../../core";

/**
 * A failed run's Investigate action. A run is named by its entry and its start
 * instant — the row's own key — so every surface investigating it reaches the
 * same task.
 */
export function InvestigateRun({ row }: ItemActionProps<EntryRun>) {
  const { entry, run } = row;
  if (run.outcome !== "failed") return null;
  return (
    <InvestigateAction
      presentation="row-action"
      noun={`${entry.name} run`}
      subject={{
        kind: "background-run",
        id: `${entry.kind}:${entry.name}@${run.startedAt}`,
      }}
      categoryId={BACKGROUND_CATEGORY_ID}
      description={`Launch an agent briefed on this failed run of ${entry.name} — its error, what the ${entry.kind} does, and where to dig.`}
      brief={(userText) => runBrief(row, userText)}
    />
  );
}

function runBrief({ entry, run }: EntryRun, userText: string): string {
  const extra = userText.trim();
  return [
    `## Investigate a failed background run`,
    "",
    `A run of the ${entry.kind} \`${entry.name}\` failed. ${entry.description}`,
    "",
    "**The run**",
    "",
    `- ${entry.kind}: \`${entry.name}\`${entry.declaredIn ? ` (declared in \`plugins/${entry.declaredIn}\`)` : ""}`,
    `- scope: ${entry.scope}`,
    `- started: ${run.startedAt}`,
    `- finished: ${run.finishedAt ?? "never recorded"}`,
    `- took: ${run.durationMs === null ? "unknown" : `${run.durationMs} ms`}`,
    ...entry.facts.map((f) => `- ${f.label}: ${f.value}`),
    "",
    ...(run.error
      ? ["**The error**, verbatim:", "", "```", run.error, "```", ""]
      : ["The run recorded no error message.", ""]),
    "**Where to dig**",
    "",
    `- Debug → Background activity → \`${entry.name}\` lists its recent runs and history;`,
    `- a failure the server caught is also a report: Debug → Reports, searching \`${entry.name}\`;`,
    "- the backend's log channels around the start instant;",
    "- read the `debug` skill first — it maps the surfaces above.",
    "",
    "Find the root cause and say what it is. Fix it if the fix is clearly in this repo.",
    ...(extra ? ["", "## What the user asked for", "", extra] : []),
  ].join("\n");
}
