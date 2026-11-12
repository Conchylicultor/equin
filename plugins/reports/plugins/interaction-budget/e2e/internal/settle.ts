import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { fileReportFromProcess } from "@plugins/reports/plugins/outbox/plugins/file/core";
import {
  INTERACTION_BUDGET_KIND,
  interactionBudgetMessage,
  overBudget,
  shortCommit,
  type BudgetCase,
  type InteractionBudgetPayload,
} from "../../core";
import { interactionBudgetStateDir } from "../../data-dirs";

/** One scenario's measured cases, and what a filing run needs to file them. */
export interface BudgetRun {
  scenario: string;
  title: string;
  metric: string;
  cases: BudgetCase[];
  rerun: string;
  hint: string;
  /**
   * Main's run (`--file-reports --commit <sha>`): the deployed commit it
   * measured. An over-budget verdict is filed as an `interaction-budget`
   * report and a within-budget one moves the scenario's range start. `null`:
   * an on-demand run, which only prints its verdict.
   */
  file: { commit: string } | null;
}

/** What a scenario's run decided. */
export type BudgetVerdict =
  { kind: "within" } | { kind: "over"; over: BudgetCase[]; filed: boolean };

const StateSchema = z.object({ commit: z.string(), at: z.string() });

function statePath(scenario: string): string {
  return join(interactionBudgetStateDir.path, `${scenario}.json`);
}

/** The last commit `scenario` was measured within budget at; null before the first. */
async function lastWithinBudget(scenario: string): Promise<string | null> {
  const text = await readFile(statePath(scenario), "utf8").catch(
    (err: unknown) => {
      if (err instanceof Error && (err as { code?: string }).code === "ENOENT")
        return null;
      throw err;
    },
  );
  return text === null ? null : StateSchema.parse(JSON.parse(text)).commit;
}

async function recordWithinBudget(
  scenario: string,
  commit: string,
): Promise<void> {
  const path = statePath(scenario);
  await mkdir(interactionBudgetStateDir.path, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(
    tmp,
    JSON.stringify({ commit, at: new Date().toISOString() }) + "\n",
  );
  await rename(tmp, path);
}

/**
 * Print a scenario's cases against their budgets, and — on a filing run —
 * settle the verdict: over budget files one `interaction-budget` report
 * (the commit range since the last run within budget), within budget records
 * this commit as that range's new start.
 *
 * A filing run whose report did not reach the outbox throws: the report, not
 * the exit code, is the verdict's delivery, so losing it must be loud.
 */
export async function settleBudget(run: BudgetRun): Promise<BudgetVerdict> {
  console.log(`\n${run.title} — ${run.metric} (median), against budget:`);
  for (const c of run.cases) {
    const mark = c.measured > c.budget ? "OVER" : "ok  ";
    console.log(
      `  ${mark} ${c.label}: ${Math.round(c.measured)} / ${c.budget}  [${c.samples.join(", ")}]`,
    );
  }
  const over = overBudget(run.cases);
  if (run.file === null)
    return over.length === 0
      ? { kind: "within" }
      : { kind: "over", over, filed: false };
  const { commit } = run.file;
  if (over.length === 0) {
    await recordWithinBudget(run.scenario, commit);
    console.log(
      `within budget at ${shortCommit(commit)} — recorded as the range start`,
    );
    return { kind: "within" };
  }
  const data: InteractionBudgetPayload = {
    scenario: run.scenario,
    title: run.title,
    metric: run.metric,
    cases: run.cases,
    commit,
    lastWithinBudget: await lastWithinBudget(run.scenario),
    rerun: run.rerun,
    hint: run.hint,
  };
  const message = interactionBudgetMessage(data);
  const outcome = await fileReportFromProcess({
    kind: INTERACTION_BUDGET_KIND,
    message,
    data,
    commit,
  });
  if (outcome.outcome !== "written")
    throw new Error(
      `could not file the ${INTERACTION_BUDGET_KIND} report (${outcome.outcome}): ${message}`,
    );
  console.log(`Filed an ${INTERACTION_BUDGET_KIND} report: ${message}`);
  return { kind: "over", over, filed: true };
}
