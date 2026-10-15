import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import type { FieldsRecord } from "@plugins/fields/core";
import type { LiveArm } from "@plugins/network/plugins/live/core";
import { Investigate } from "@plugins/primitives/plugins/launch/plugins/investigate/web";
import { runSubject, type RunRow } from "../../core";

/** What an arm says about investigating one of its failed runs. */
export interface RunInvestigation {
  /** What failed, in the copy ("build", "backup"). */
  noun: string;
  /** The task category the investigation is filed under. */
  categoryId: string;
  /**
   * Where the agent digs for what the row does not hold — the transcript, the
   * ledger row, the engine that ran it — one markdown bullet each.
   */
  whereToDig: (run: RunRow) => readonly string[];
}

/**
 * The Investigate action on every FAILED run of `arm`, in every list of runs
 * (`Investigate.Register` over the arm). The brief is built here, once, from
 * the row itself: the run's base fields, its message verbatim, then every one
 * of the arm's own fields by its label — so no arm hand-writes the facts a row
 * already holds, and every run kind is briefed the same way.
 */
export function investigateRuns(
  arm: LiveArm<RunRow, FieldsRecord, string>,
  { noun, categoryId, whereToDig }: RunInvestigation,
): Contribution {
  return Investigate.Register<RunRow>({
    owner: arm,
    failed: (run) => run.kind === armKind(arm) && run.outcome === "failed",
    noun,
    categoryId,
    subject: (run) => runSubject(run),
    description: (run) =>
      `Launch an agent briefed on this failed ${noun} — ${run.label}: its message, every field the run recorded, and where to dig.`,
    brief: (run, userText) =>
      runBrief(arm, run, noun, whereToDig(run), userText),
  });
}

function armKind(arm: LiveArm<RunRow, FieldsRecord, string>): string {
  if (arm.owner.kind !== "arm") {
    throw new Error(`investigateRuns: ${arm.name} is not a union arm`);
  }
  return arm.owner.arm;
}

function runBrief(
  arm: LiveArm<RunRow, FieldsRecord, string>,
  run: RunRow,
  noun: string,
  dig: readonly string[],
  userText: string,
): string {
  const own = arm.read(run) as Record<string, unknown> | null;
  const armFacts = Object.values(arm.listed).map(
    (f) => `- ${f.label}: ${fact(own?.[f.key])}`,
  );
  const extra = userText.trim();
  return [
    `## Investigate a failed ${noun}`,
    "",
    `**${run.label}** failed.`,
    "",
    "**The run**",
    "",
    `- ${noun} run id: \`${run.id}\` (in the merged runs list as \`${run.runKey}\`)`,
    `- started: ${run.startedAt.toISOString()}`,
    `- finished: ${run.finishedAt ? run.finishedAt.toISOString() : "never recorded"}`,
    `- trigger: ${fact(run.trigger)}`,
    `- namespace: ${fact(run.namespace)}`,
    ...armFacts,
    "",
    ...(run.message
      ? ["**What it said**, verbatim:", "", "```", run.message, "```", ""]
      : ["The run recorded no message.", ""]),
    "**Where to dig**",
    "",
    ...dig.map((d) => `- ${d}`),
    "",
    "Find the root cause and say what it is. Fix it if the fix is clearly in this repo; if it is host or remote state, say exactly what is wrong and what would repair it.",
    ...(extra ? ["", "## What the user asked for", "", extra] : []),
  ].join("\n");
}

function fact(value: unknown): string {
  if (value === null || value === undefined) return "none recorded";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  if (typeof value === "string") return `\`${value}\``;
  return String(value);
}
