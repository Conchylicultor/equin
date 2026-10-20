import { z } from "zod";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";

/**
 * The name Claude Code gives the tool that messages a sub-agent in a
 * transcript's `tool_use` block. Sent to a sub-agent that has stopped, it
 * RESUMES it: a new turn in the same transcript, under the same agent id.
 */
export const SEND_MESSAGE_TOOL_NAME = "SendMessage";

/**
 * The result body of a `SendMessage` that woke a stopped sub-agent:
 * `{"success":true,"message":"Resuming agent …","resumedAgentId":<agentId>,…}`.
 * A message to an agent still running is queued instead and carries no
 * `resumedAgentId` — it starts nothing, so it is not a resume.
 */
const ResumeResultSchema = z.object({ resumedAgentId: z.string() });

/**
 * When each sub-agent was last resumed, by agent id — read from the `SendMessage`
 * calls in the PARENT transcript whose result says they resumed it.
 *
 * A background sub-agent's completion (its `task-notification`) is not final:
 * Claude Code notifies "each time this agent stops", and a `SendMessage` starts
 * it again. A completion signal older than the newest resume is therefore
 * stale — the agent is working on the resumed turn — and only the next
 * notification finishes it again. Without this, the first notification
 * finished the agent for good, and every resumed turn after it ran invisibly
 * (conv-1791379404-0sgk: one agent resumed four times, never shown working).
 *
 * The time is the call's own (`at`): the resume begins when it is sent.
 */
export function agentResumeTimes(
  events: readonly JsonlEvent[],
): Map<string, string> {
  const resumed = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== "tool-call" || event.name !== SEND_MESSAGE_TOOL_NAME) {
      continue;
    }
    const agentId = resumedAgentIdOf(event.result?.content);
    if (agentId === null) continue;
    const previous = resumed.get(agentId);
    if (previous === undefined || Date.parse(event.at) > Date.parse(previous)) {
      resumed.set(agentId, event.at);
    }
  }
  return resumed;
}

function resumedAgentIdOf(content: string | undefined): string | null {
  // A failed send, or one queued to a running agent, is prose or another body.
  if (content === undefined || !content.trimStart().startsWith("{")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
  const result = ResumeResultSchema.safeParse(parsed);
  return result.success ? result.data.resumedAgentId : null;
}
