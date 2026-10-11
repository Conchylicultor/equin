import * as z4 from "zod/v4";
import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { getConfig } from "@plugins/config_v2/server";
import { runClaudeReadOnly } from "@plugins/infra/plugins/claude-cli/server";
import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";
import { runGit } from "@plugins/primitives/plugins/commit-list/server";
import { renderPrompt } from "@plugins/tasks/plugins/automations/core";
import { tasksView } from "@plugins/tasks/plugins/tasks-core/server";
import { getTaskTrack } from "@plugins/tasks/plugins/task-track/server";
import {
  MAX_RECENT_COMMITS,
  sidequestAutopilotConfig,
} from "../../shared/config";
import {
  MAX_TRIAGE_ANSWERS,
  TRIAGE_RISKS,
  TRIAGE_VERDICTS,
} from "../../shared/triage";
import { log } from "./log";
import { tasksSidequestTriage } from "./tables";

/** The model triage reads with. */
const TRIAGE_TIER = "sonnet";
/** A triage read's ceiling: a look around the code, not a session. */
const TRIAGE_TIMEOUT_MS = 10 * 60_000;

/**
 * What a triage read answers with — handed to the CLI as its JSON schema and
 * parsed with it, so the record is checked where it is produced.
 */
const TriageAnswerSchema = z4.object({
  verdict: z4.enum(TRIAGE_VERDICTS),
  context: z4.string().min(1),
  question: z4.string().min(1).nullable(),
  answers: z4.array(z4.string().min(1).max(60)).max(MAX_TRIAGE_ANSWERS),
  risk: z4.enum(TRIAGE_RISKS),
  sizeMinutes: z4.number().int().min(1).max(5000),
  value: z4.number().int().min(1).max(5),
  areas: z4.array(z4.string().min(1)).max(12),
});

const SYSTEM = `You triage software tasks for a person who will decide which ones an unattended coding agent may work on. You only read code — you have Read, Grep and Glob over the repository in your working directory, nothing else. Be concrete and honest; "obsolete" needs evidence. Answer with the structured record only.`;

/** What one call to `triageSidequest` did. */
export type TriageOutcome =
  { kind: "triaged"; verdict: string } | { kind: "skipped"; reason: string };

/**
 * Read one sidequest with read-only Sonnet and store what it made of it.
 * Skips (writes nothing) a task that is not a ready (`new`) sidequest, one
 * triaged already unless `force`, and everything while triage is off. Throws
 * on a failed or malformed read — the job's retry, then a loud failure.
 */
export async function triageSidequest(
  taskId: string,
  { force }: { force: boolean },
): Promise<TriageOutcome> {
  const config = getConfig(sidequestAutopilotConfig);
  if (!config.triage) return { kind: "skipped", reason: "triage is off" };
  const [task] = await db
    .select({
      title: tasksView.title,
      description: tasksView.description,
      status: tasksView.status,
      createdAt: tasksView.createdAt,
    })
    .from(tasksView)
    .where(eq(tasksView.id, taskId));
  if (task === undefined) return { kind: "skipped", reason: "no such task" };
  if (task.status !== "new") {
    return { kind: "skipped", reason: `status ${task.status}` };
  }
  if ((await getTaskTrack(taskId)) !== "sidequest") {
    return { kind: "skipped", reason: "not a sidequest" };
  }
  if (!force && (await tasksSidequestTriage.get(taskId)) !== undefined) {
    return { kind: "skipped", reason: "triaged already" };
  }

  const mainRoot = await ensureMainWorktreeRoot();
  const [mainSha, recentCommits] = await Promise.all([
    runGit(["rev-parse", "refs/heads/main"], mainRoot),
    runGit(
      [
        "log",
        "--oneline",
        "--no-decorate",
        `--since=${task.createdAt.toISOString()}`,
        `-n`,
        String(MAX_RECENT_COMMITS),
        "refs/heads/main",
      ],
      mainRoot,
    ),
  ]);
  const description = task.description?.trim() ?? "";
  const prompt = renderPrompt(config.triagePrompt, {
    taskId,
    title: task.title.trim() || "Untitled",
    description:
      description || "(No description — the title is the whole task.)",
    filedAgo: ago(task.createdAt, new Date()),
    recentCommits: recentCommits.trim() || "(none)",
  });
  if (!prompt.ok) {
    throw new Error(
      `sidequest-autopilot: its triage prompt uses ${prompt.unknown.map((n) => `{{${n}}}`).join(", ")}, which triage does not fill — fix triagePrompt in its config`,
    );
  }

  const answer = await runClaudeReadOnly({
    tier: TRIAGE_TIER,
    prompt: prompt.text,
    system: SYSTEM,
    readDir: mainRoot,
    output: TriageAnswerSchema,
    timeoutMs: TRIAGE_TIMEOUT_MS,
    source: { name: "sidequest-autopilot.triage", context: { taskId } },
  });
  // A question without answers (or the reverse) is half a question: keep
  // the pair only when both are there.
  const asks = answer.question !== null && answer.answers.length > 0;
  await tasksSidequestTriage.upsert(taskId, {
    verdict: answer.verdict,
    context: answer.context,
    question: asks ? answer.question : null,
    answers: asks ? answer.answers : [],
    answer: null,
    risk: answer.risk,
    sizeMinutes: answer.sizeMinutes,
    value: answer.value,
    areas: answer.areas,
    mainSha: mainSha.trim(),
    sourceTitle: task.title,
    sourceDescription: task.description ?? "",
    triagedAt: new Date(),
  });
  log.publish(
    `sidequest-autopilot: triaged ${taskId} — ${answer.verdict}, risk ${answer.risk}, ~${answer.sizeMinutes} min, value ${answer.value}`,
  );
  return { kind: "triaged", verdict: answer.verdict };
}

/** "3 days ago", "5 hours ago", "just now" — for the prompt. */
export function ago(then: Date, now: Date): string {
  const hours = Math.floor((now.getTime() - then.getTime()) / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}
