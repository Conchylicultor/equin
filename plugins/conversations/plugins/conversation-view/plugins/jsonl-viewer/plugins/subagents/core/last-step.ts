import type { LastStep } from "./protocol";

/** Longest preview we ship. A second line under a card's summary, not a paragraph. */
const PREVIEW_MAX = 80;

/**
 * Tool-input keys worth showing, most identifying first.
 *
 * `description` leads: when the caller wrote one (Bash, Agent), it is the
 * human-readable intent — "Resolve conflict and continue rebase" — where the
 * raw `command` is the internal mechanics a reader has to decode. The main
 * transcript's Bash card shows the same words.
 *
 * A CLOSED list of plain data, deliberately not a slot: it is the handful of
 * argument names Claude's own tools use for "the thing being acted on", and it
 * is tool-AGNOSTIC by construction — it names arguments, never tools. A renderer
 * that wants "searched 3 files for X" is reading a fully built event with its
 * result paired, which is the whole-file parse this tail read exists to avoid.
 */
const TOOL_INPUT_KEYS = [
  "description",
  "file_path",
  "notebook_path",
  "command",
  "pattern",
  "path",
  "url",
  "query",
  "prompt",
] as const;

/** Keys whose value is a filesystem path, shown as its last segment. */
const PATH_KEYS = new Set<string>(["file_path", "notebook_path", "path"]);

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_MAX
    ? `${flat.slice(0, PREVIEW_MAX - 1)}…`
    : flat;
}

function previewOfToolInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const record = input as Record<string, unknown>;
  for (const key of TOOL_INPUT_KEYS) {
    const value = record[key];
    if (typeof value !== "string" || value === "") continue;
    return truncate(
      PATH_KEYS.has(key) ? (value.split("/").at(-1) ?? value) : value,
    );
  }
  return "";
}

/**
 * Classify ONE raw transcript line into the step it represents.
 *
 * `null` means this line says nothing about what the sub-agent is doing (a
 * harness `attachment` line, a `system` line, a line with no message). Callers
 * scanning a tail should walk backwards until a line classifies, rather than
 * treating the very last line as authoritative — the harness routinely appends
 * bookkeeping lines after the assistant's.
 */
export function classifyLastStep(
  line: Record<string, unknown>,
): LastStep | null {
  const message = line.message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as Record<string, unknown>).content;

  if (typeof content === "string") {
    const preview = truncate(content);
    return preview === "" ? null : { kind: "text", preview };
  }
  if (!Array.isArray(content)) return null;

  // The LAST block of the message is the most recent thing it did.
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "tool_use" && typeof b.name === "string") {
      return {
        kind: "tool",
        toolName: b.name,
        preview: previewOfToolInput(b.input),
      };
    }
    if (b.type === "tool_result") return { kind: "tool-result" };
    if (b.type === "text" && typeof b.text === "string") {
      const preview = truncate(b.text);
      if (preview !== "") return { kind: "text", preview };
    }
    if (b.type === "thinking" && typeof b.thinking === "string") {
      const preview = truncate(b.thinking);
      if (preview !== "") return { kind: "thinking", preview };
    }
  }
  return null;
}

/**
 * The words a surface shows for a step. ONE formatter, so a card and any future
 * consumer phrase the same reading identically.
 */
export function formatLastStep(step: LastStep): string {
  switch (step.kind) {
    case "tool":
      return step.preview === ""
        ? step.toolName
        : `${step.toolName} ${step.preview}`;
    case "tool-result":
      return "Finished a tool call";
    case "thinking":
      return `Thinking: ${step.preview}`;
    case "text":
      return step.preview;
  }
}

/**
 * The most recent thing a sub-agent DID, read backwards from a window of its
 * transcript.
 *
 * The rule that is not obvious: **a trailing `tool_result` defers to the
 * `tool_use` it answers.** A result always lands immediately after its call, so
 * the newest line is a result about a third of the time at any live moment (348
 * of 992 sampled cut points across the 826 transcripts here) — and a result's
 * text is the payload, not a description. Reporting it literally put a file's
 * line-numbered contents on the card in place of "Read row-actions/CLAUDE.md".
 *
 * So when the newest classifiable line is a result, the scan keeps going for the
 * action that produced it. That action is in the same window 340 times out of
 * those 348, and only when it is not — 8 of 348 — does the bare `tool-result`
 * arm survive, saying that a call finished without pretending to know which.
 * Never `null` there: a sub-agent mid-tool-loop has plainly not "not started".
 *
 * Text and thinking still win outright when they are newest. Those are the
 * sub-agent speaking, which says more than any tool name — and they are only
 * skipped when they are OLDER than a trailing result, where reporting them would
 * mean quoting something the sub-agent said before the step it has since taken.
 */
export function lastStepOfLines(
  lines: readonly Record<string, unknown>[],
): LastStep | null {
  let trailingResult = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const step = classifyLastStep(lines[i]!);
    if (step === null) continue;
    if (!trailingResult) {
      if (step.kind !== "tool-result") return step;
      // Keep looking for the call this result answers.
      trailingResult = true;
      continue;
    }
    if (step.kind === "tool") return step;
  }
  return trailingResult ? { kind: "tool-result" } : null;
}
