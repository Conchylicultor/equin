import type { z } from "zod";

/** Issues quoted into one message; a wholly different payload has hundreds. */
const MAX_ISSUES = 8;

/**
 * Parse `value` with `schema`, or throw one message naming `what` and the
 * offending fields (`chords.3.borrowed: Expected string, received array`) — so a
 * change in Hooktheory's payload reads as exactly that, at the boundary.
 */
export function parseOrThrow<T>(
  schema: z.ZodType<T>,
  value: unknown,
  what: string,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const { issues } = result.error;
  const quoted = issues
    .slice(0, MAX_ISSUES)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  const more =
    issues.length > MAX_ISSUES ? ` (+${issues.length - MAX_ISSUES} more)` : "";
  throw new Error(
    `${what} did not match the expected shape — ${quoted}${more}`,
  );
}
