import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  MAX_CHECKOUT_STEPS,
  type AgentLaunchPhase,
  type CheckoutSourceKind,
  type CheckoutStep,
  type LaunchMarks,
} from "../../core";
import { launches } from "./tables";

// The launch record's writers. Every mark is first-wins — `new || marks`
// (jsonb concatenation: the right side's keys win) — so a retried spawn, a
// re-requested checkout or a replayed events file never moves an instant
// already recorded.

const t = launches.table;

function mergeFirstWins(marks: LaunchMarks) {
  return sql`${JSON.stringify(marks)}::jsonb || ${t.marks}`;
}

/**
 * The spawn job's body runs: open the conversation's launch record, from its
 * request (the conversation's creation). A retry finds it open and keeps it.
 */
export async function openLaunch(
  conversationId: string,
  attemptId: string,
  requestedAt: Date,
): Promise<void> {
  await db
    .insert(t)
    .values({
      conversationId,
      attemptId,
      requestedAt,
      marks: { "spawn-started": Date.now() },
      checkoutSteps: [],
      checkoutSource: null,
      abandonedAt: null,
    })
    .onConflictDoNothing();
}

/**
 * The checkout child booted: when its process started (before its slot wait
 * and boot) and when its run body began. Written before the checkout, so a
 * checkout that hangs still shows where it is.
 */
export async function markCheckoutBooted(
  conversationId: string,
  at: { childStartedAt: number; bootedAt: number },
): Promise<void> {
  await db
    .update(t)
    .set({
      marks: mergeFirstWins({
        "prepare-child-started": at.childStartedAt,
        "prepare-booted": at.bootedAt,
      }),
    })
    .where(eq(t.conversationId, conversationId));
}

/**
 * The checkout child's checkout ended: its steps, and how it was made. A
 * later run (a re-request) leaves an ended checkout's record as it was.
 */
export async function markCheckoutEnded(
  conversationId: string,
  ended: {
    endedAt: number;
    steps: readonly CheckoutStep[];
    source: CheckoutSourceKind;
  },
): Promise<void> {
  await db
    .update(t)
    .set({
      marks: mergeFirstWins({ "prepare-ended": ended.endedAt }),
      checkoutSteps: ended.steps.slice(0, MAX_CHECKOUT_STEPS),
      checkoutSource: ended.source,
    })
    .where(
      and(
        eq(t.conversationId, conversationId),
        sql`NOT (${t.marks} ? 'prepare-ended')`,
      ),
    );
}

/**
 * The spawn gave up before its agent started (dead-lettered, or Claude Code
 * missing): the record stays as far as it got, and no later process claims
 * it. A launch whose agent already started keeps its claim.
 */
export async function abandonLaunch(conversationId: string): Promise<void> {
  await db
    .update(t)
    .set({ abandonedAt: new Date() })
    .where(
      and(
        eq(t.conversationId, conversationId),
        isNull(t.agentPid),
        isNull(t.abandonedAt),
      ),
    );
}

/**
 * The agent process reported a launch phase (its events file). `started`
 * claims the launch for its process — only the first process does; every
 * later phase marks it only when it comes from that process, so a resume
 * days later never fills in what the launch's own agent did not report — nor
 * claims a launch whose spawn gave up (`abandonLaunch`).
 * A conversation with no launch record (one started before records, or by a
 * resume) writes nothing.
 */
export async function markAgentLaunchPhase(
  conversationId: string,
  pid: number,
  phase: AgentLaunchPhase,
  at: Date,
): Promise<void> {
  const marks: LaunchMarks = { [phase]: at.getTime() };
  if (phase === "agent-started") {
    await db
      .update(t)
      .set({ marks: mergeFirstWins(marks), agentPid: pid })
      .where(
        and(
          eq(t.conversationId, conversationId),
          isNull(t.agentPid),
          isNull(t.abandonedAt),
        ),
      );
    return;
  }
  await db
    .update(t)
    .set({ marks: mergeFirstWins(marks) })
    .where(
      and(
        eq(t.conversationId, conversationId),
        eq(t.agentPid, pid),
        sql`NOT (${t.marks} ? ${phase})`,
      ),
    );
}
