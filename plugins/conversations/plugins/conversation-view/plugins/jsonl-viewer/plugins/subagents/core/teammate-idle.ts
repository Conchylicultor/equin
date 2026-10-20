import { z } from "zod";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";

/**
 * The body of the message Claude Code relays to the lead when a teammate ends
 * its turn and waits for more: `{"type":"idle_notification","from":<name>,
 * "timestamp":…,"idleReason":"available",…}`. Only the fields this reading
 * needs; everything else is passed over.
 */
const IdleNotificationSchema = z.object({
  type: z.literal("idle_notification"),
  from: z.string(),
  timestamp: z.string(),
});

/**
 * When each teammate last went idle, by name — read from the
 * `idle_notification` messages relayed into the PARENT transcript.
 *
 * This is to an in-process teammate what the `task-notification` is to a
 * background `Agent` call: the parent being told the sub-agent's turn is over.
 * A teammate gets no task-notification (it has no tool-use id to carry), and
 * its own transcript's `end_turn` marker is often missing — Claude Code 2.1.29x
 * writes a turn's last text piece with `stop_reason: null` — so without this a
 * teammate that had reported and gone quiet read "running" for as long as its
 * lead lived.
 *
 * Keyed by the `from` name, which is the name the teammate was spawned with
 * (its row's `name`). The newest notification per name wins. A body that is not
 * an idle notification — a prose report, another status type — is skipped.
 */
export function teammateIdleTimes(
  events: readonly JsonlEvent[],
): Map<string, string> {
  const idle = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== "teammate-message") continue;
    const notification = idleNotificationOf(event.body);
    if (notification === null) continue;
    const previous = idle.get(notification.from);
    if (
      previous === undefined ||
      Date.parse(notification.timestamp) > Date.parse(previous)
    ) {
      idle.set(notification.from, notification.timestamp);
    }
  }
  return idle;
}

function idleNotificationOf(
  body: string,
): z.infer<typeof IdleNotificationSchema> | null {
  // Most teammate messages are prose reports; only a JSON object body can be a
  // status notification.
  if (!body.trimStart().startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
  const result = IdleNotificationSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
