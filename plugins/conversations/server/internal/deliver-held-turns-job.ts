import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { ReportKind, type ReportRow } from "@plugins/reports/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { hasHeldTurns } from "@plugins/conversations/plugins/turn-ledger/server";
import { waitUntilReady } from "./runtime";
import { deliverHeldTurns } from "./turns";

// Path B of held-turn delivery (turns.ts): type every turn held while the
// conversation was starting, once the agent can take input. Enqueued by the
// status reconciler after it moves a row out of `starting`, and by a resume
// (which puts the row back into `starting`) — a push trigger, never a poll.
export const deliverHeldTurnsJob = defineJob({
  name: "conversations.deliver-held-turns",
  description:
    "Types the messages a user sent while their agent was still starting, once the agent has drawn its input box.",
  // minutes: it waits (bounded at 60 s) for a just-started agent to draw its
  // input box, then delivers each held turn through the verified send to
  // the agent process, several seconds each. Nothing shorter than the work bounds it.
  hold: "minutes",
  inProcess:
    "A held turn leaves `held` only as its delivery starts, so a run killed " +
    "by a restart re-runs and types only what was still held.",
  input: z.object({ conversationId: z.string() }),
  // Direct-enqueue only (the status reconciler and respawnResume).
  event: z.never(),
  // jobKey "conversations.deliver-held-turns:<conversationId>" — a second flip
  // while one is queued folds into it; one enqueued while a run is in flight
  // runs after it, and finds only what that run did not deliver.
  dedup: { key: (input) => input.conversationId },
  maxAttempts: 3,
  run: async ({ input: { conversationId }, ctx: { signal } }) => {
    // Every flip out of `starting` enqueues this; almost none has anything held.
    // Answer that before waiting on a box nobody needs.
    if (!(await hasHeldTurns(conversationId))) return;

    if ((await waitUntilReady(conversationId, signal)) === "timeout") {
      // Left held, not dropped: the next flip out of `starting` or a Resume
      // enqueues this again and can still deliver it.
      await recordReport({
        kind: "held-turn-undelivered",
        source: "server-caught",
        message: `${conversationId}: the agent never drew its input box, so the messages sent while it was starting are still held`,
        data: { conversationId },
      });
      return;
    }

    await deliverHeldTurns(conversationId);
  },
});

const HeldTurnUndeliveredSchema = z.object({ conversationId: z.string() });

/**
 * The `held-turn-undelivered` report kind: **a user sent messages while their
 * agent was starting, and the agent never became ready to take them** — its
 * input box did not appear within the bound after the status left `starting`.
 * The turns stay held; one row per conversation, its count the attempts.
 */
export const heldTurnUndeliveredKind = ReportKind({
  kind: "held-turn-undelivered",
  schema: HeldTurnUndeliveredSchema,
  fingerprint: (d: z.infer<typeof HeldTurnUndeliveredSchema>) =>
    `held-turn-undelivered:${d.conversationId}`,
  meta: {
    tag: "[held-turn]",
    notif: "A message sent while the agent was starting is still waiting",
    variant: "warning",
  },
  renderTask: (row: ReportRow) => {
    const d = HeldTurnUndeliveredSchema.parse(row.data);
    return {
      title: `[held-turn] Messages sent while starting were not delivered: ${d.conversationId}`,
      description: [
        `Conversation \`${d.conversationId}\` left \`starting\`, but its agent never ` +
          "drew its input box within 60 s, so the `conversations.deliver-held-turns` " +
          "job could not type the messages the user sent while it was starting. " +
          "They are still `held` in `conversation_turns`; the next flip out of " +
          "`starting` or a Resume delivers them.",
        "",
        "Look at the agent's log (`agent.log`, beside its `events.jsonl` in the " +
          "`state/sdk-agents/<namespace>/<conversationId>/` data dir): an " +
          "agent process that never answered over its socket reads exactly like " +
          "a box that never appeared.",
        "",
        `**Occurrences:** ${row.count}`,
        `**First seen:** ${row.firstSeenAt.toISOString()}`,
        `**Last seen:** ${row.lastSeenAt.toISOString()}`,
      ].join("\n"),
    };
  },
});
