import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { toolResultIsOutcome, type SubagentRequestShape } from "./protocol";

type ToolCallEvent = Extract<JsonlEvent, { kind: "tool-call" }>;

/** The tool a sub-agent hands its write-up back to the caller through. */
const HANDBACK_TOOL = "SubagentHandback";

/**
 * A sub-agent's write-up, or the fact that none can be recovered.
 *
 * `none` is a real answer, not a failure: plenty of sub-agents finish without
 * anything that can honestly be called a report, and a surface that had to
 * produce one anyway would print the nearest string it could find.
 */
export type SubagentReport =
  { kind: "none" } | { kind: "report"; text: string; isError: boolean };

/** The `message` a handback carries, if it carries one. */
function handbackMessage(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const message = (input as Record<string, unknown>).message;
  return typeof message === "string" && message !== "" ? message : undefined;
}

/**
 * Where a sub-agent's write-up lives — which is a different place per request
 * shape, and is the whole reason this is a function rather than a field read.
 *
 * - **foreground** — the parent's `tool_result` is the call's RETURN VALUE, so
 *   it is the report, errors included (`toolResultIsOutcome`).
 * - **background** — that same `tool_result` is an immediate launch receipt
 *   ("Async agent launched successfully… agentId: …"), which the harness marks
 *   as internal metadata never to be surfaced. Showing it under the heading
 *   "Report" is wrong three times over: it is not the report, it is explicitly
 *   not for display, and it buries the work. The report is instead the last
 *   `SubagentHandback` call in the sub-agent's OWN transcript, whose `message`
 *   is the write-up it handed back.
 * - **unknown shape** — the `tool_result` could be either, and there is no way
 *   to tell which, so nothing is claimed.
 *
 * Measured over the 890 sub-agent meta files on this machine (2026-09-20):
 * a handback appears **only** under `background` (160 of 419), never under
 * `foreground` (0 of 8) and never where the shape is absent (0 of 396). So this
 * is genuinely per-shape — the two cases do not converge on one source — and a
 * background sub-agent from before the harness wrote handbacks (2026-09-15)
 * simply has no recoverable report. That is `none`, and the caller shows no
 * card: its transcript is already on screen underneath.
 */
export function subagentReport({
  requestShape,
  agentToolEvent,
  events,
}: {
  /** From the meta file. `undefined` = the harness did not record it. */
  requestShape: SubagentRequestShape | undefined;
  /** The parent's `Agent` tool-call event. */
  agentToolEvent: ToolCallEvent | undefined;
  /** The SUB-AGENT's own transcript — empty when it has none. */
  events: readonly JsonlEvent[];
}): SubagentReport {
  if (toolResultIsOutcome(requestShape)) {
    const result = agentToolEvent?.result;
    if (result === undefined) return { kind: "none" };
    return {
      kind: "report",
      text: result.content,
      isError: result.isError === true,
    };
  }
  if (requestShape === "background") {
    // The LAST handback: a sub-agent can hand back more than once, and the
    // final one is what the caller was left holding.
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event?.kind !== "tool-call" || event.name !== HANDBACK_TOOL) continue;
      const text = handbackMessage(event.input);
      if (text !== undefined) return { kind: "report", text, isError: false };
    }
  }
  return { kind: "none" };
}
