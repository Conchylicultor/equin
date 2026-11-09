/**
 * The input fields that say what a call is about, most telling first: a call
 * whose input carries one is summed up by it, whatever the tool.
 */
const SALIENT_FIELDS = [
  "description",
  "title",
  "query",
  "prompt",
  "command",
  "url",
  "file_path",
  "path",
  "pattern",
  "name",
  "message",
  "reason",
] as const;

/** Longer than this, a string field is content (a body, a file), not a label. */
const MAX_FALLBACK_LENGTH = 200;

const firstLine = (text: string): string =>
  text.trim().split("\n", 1)[0]!.trim();

/**
 * One line saying what a tool call is about, read from its input alone — so
 * any tool's card has a header worth reading, a tool no renderer knows
 * included, and a call still being written (its input a partial object):
 * the first salient field holding text, else the input's first short string
 * field. Undefined when the input holds no text at all.
 */
export function inputSummary(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const fields = input as Record<string, unknown>;
  for (const key of SALIENT_FIELDS) {
    const value = fields[key];
    if (typeof value === "string" && value.trim() !== "")
      return firstLine(value);
  }
  for (const value of Object.values(fields)) {
    if (
      typeof value === "string" &&
      value.trim() !== "" &&
      value.length <= MAX_FALLBACK_LENGTH
    )
      return firstLine(value);
  }
  return undefined;
}
