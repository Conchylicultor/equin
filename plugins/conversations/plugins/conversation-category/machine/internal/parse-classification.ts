import { z } from "zod";

/**
 * The classifier's answer: one entry per category it was asked about, keyed by
 * the category's id (or, tolerantly, its name — see `resolveAnswer`).
 */
const ClassificationSchema = z.record(z.string(), z.string());
export type Classification = z.infer<typeof ClassificationSchema>;

export class ClassificationParseError extends Error {}

/** Enough of the model's answer to see what went wrong, bounded for a log line. */
const MAX_EXCERPT = 400;

function excerpt(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length > MAX_EXCERPT
    ? `${trimmed.slice(0, MAX_EXCERPT)}…`
    : trimmed;
}

/**
 * Carve the JSON object out of a response that may be wrapped in prose or a
 * ```json fence.
 *
 * A brace scan rather than a regex, and string-aware: a `}` inside an item name
 * must not end the object, and a `\"` inside it must not end the string.
 * Anything before the first `{` and after its match is discarded — the model
 * being chatty is not a failure. Mirrors `isolateJsonArray` in
 * `apps/events/sources/url-extract`.
 */
function isolateJsonObject(raw: string): string {
  const start = raw.indexOf("{");
  if (start === -1) {
    throw new ClassificationParseError(
      `Classification response contained no JSON object: ${excerpt(raw)}`,
    );
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  throw new ClassificationParseError(
    `Classification response had an unterminated JSON object: ${excerpt(raw)}`,
  );
}

/**
 * Parse a `runClaudePrint` reply into `{ <category key>: <item answer> }`.
 *
 * Throws rather than returning `{}`: an empty object is a legitimate answer
 * ("none of these categories apply"), so a parse failure must not be able to
 * masquerade as one.
 */
export function parseClassification(raw: string): Classification {
  const json = isolateJsonObject(raw);

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new ClassificationParseError(
      `Classification response was not valid JSON (${err.message}): ${excerpt(raw)}`,
      { cause: err },
    );
  }

  const parsed = ClassificationSchema.safeParse(value);
  if (!parsed.success) {
    throw new ClassificationParseError(
      `Classification response was not an object of string values (${parsed.error.message}): ${excerpt(raw)}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
