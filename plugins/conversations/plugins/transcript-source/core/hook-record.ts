import { z } from "zod";

/**
 * What one hook run came to, as far as the reader of a transcript cares: it
 * passed, fed the agent context or a message, failed, blocked what it ran on,
 * or was cancelled. `block` is the outcome that changes the call — a
 * `PreToolUse` block means the call never ran.
 */
export const HookOutcomeSchema = z.enum([
  "pass",
  "context",
  "message",
  "error",
  "block",
  "cancelled",
]);
export type HookOutcome = z.infer<typeof HookOutcomeSchema>;

/**
 * One Claude Code hook record (an `attachment` line whose `attachment.type` is
 * a `hook_*` subtype), normalised. A record naming a tool call rides on that
 * call (`tool-call.hooks`); one that names none stays an attachment event.
 */
export const HookRecordSchema = z.object({
  at: z.string(),
  /** The hook event: `PreToolUse`, `PostToolUse`, `SessionStart`, … */
  event: z.string(),
  /** The hook's name as Claude Code writes it: `PreToolUse:Bash`. */
  name: z.string(),
  outcome: HookOutcomeSchema,
  /** What the hook said: its block/stop message, its added context (joined),
   *  or its system message. Absent for a bare execution record. */
  text: z.string().optional(),
  command: z.string().optional(),
  exitCode: z.number().optional(),
  durationMs: z.number().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
});
export type HookRecord = z.infer<typeof HookRecordSchema>;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" ? v : undefined;

function outcomeOf(
  subtype: string,
  att: Record<string, unknown>,
): HookOutcome | undefined {
  switch (subtype) {
    case "hook_success":
      return (num(att.exitCode) ?? 0) !== 0 || str(att.stderr)?.trim()
        ? "error"
        : "pass";
    case "hook_additional_context":
      return "context";
    case "hook_system_message":
      return "message";
    case "hook_non_blocking_error":
      return "error";
    case "hook_blocking_error":
    case "hook_stopped_continuation":
      return "block";
    case "hook_cancelled":
      return "cancelled";
    default:
      return undefined;
  }
}

function textOf(subtype: string, att: Record<string, unknown>) {
  if (subtype === "hook_additional_context") {
    const items = Array.isArray(att.content)
      ? att.content.filter((c): c is string => typeof c === "string")
      : [];
    return items.length ? items.join("\n\n") : undefined;
  }
  return str(att.message) ?? str(att.content);
}

/**
 * The hook record an attachment carries, with the tool call it names — or
 * `{ kind: "not-a-hook" }` for any other attachment, including a `hook_*`
 * subtype this mapping does not know yet (it stays a standalone event, where
 * the fallback renderer shows it raw).
 */
export function hookRecordOf(
  subtype: string,
  att: Record<string, unknown>,
  at: string,
):
  | { kind: "hook"; record: HookRecord; toolUseId: string | undefined }
  | { kind: "not-a-hook" } {
  const outcome = outcomeOf(subtype, att);
  if (!outcome) return { kind: "not-a-hook" };
  const event = str(att.hookEvent) ?? "";
  return {
    kind: "hook",
    toolUseId: str(att.toolUseID),
    record: {
      at,
      event,
      name: str(att.hookName) ?? event,
      outcome,
      text: textOf(subtype, att),
      command: str(att.command),
      exitCode: num(att.exitCode),
      durationMs: num(att.durationMs),
      stdout: str(att.stdout),
      stderr: str(att.stderr),
    },
  };
}

const RESULT_BLOCK = /^(PreToolUse):(\S+) hook error: ([\s\S]*)$/;

/**
 * The PreToolUse block a tool result reports, when the result IS the hook's
 * refusal (`PreToolUse:Bash hook error: <message>`) — Claude Code replaces a
 * blocked call's result with it, and does not always write the matching
 * `hook_*` attachment, so the result is the one record every block leaves.
 */
export function resultBlockOf(
  content: string,
  at: string,
): HookRecord | undefined {
  const m = RESULT_BLOCK.exec(content);
  if (!m) return undefined;
  const [, event, tool, text] = m;
  return {
    at,
    event: event!,
    name: `${event}:${tool}`,
    outcome: "block",
    text: text!.trim() || undefined,
  };
}

/** The same hook outcome twice — a block read off the result, then the
 *  attachment Claude Code wrote for it. */
export function sameHookOutcome(a: HookRecord, b: HookRecord): boolean {
  return (
    a.name === b.name &&
    a.outcome === b.outcome &&
    (a.text ?? "").trim() === (b.text ?? "").trim()
  );
}
