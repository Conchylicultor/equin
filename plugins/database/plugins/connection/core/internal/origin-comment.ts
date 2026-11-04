// A statement names the code that issued it, in its own text: a leading SQL
// comment, `/* origin=<label> */ `. It is how the DATABASE side can say who
// holds a lock or sits idle in a transaction — `pg_stat_activity.query` shows a
// session's current (or last) statement verbatim, comment included.
//
// Why the text, and not `application_name`: the app pool reaches Postgres
// through pgbouncer in transaction mode, so a server session is shared by every
// client in turn and no session setting survives from one transaction to the
// next. The text travels with the statement itself.
//
// The label is the runtime-profiler entry the call runs under
// (`currentEntryLabel()`: "conversations.usage:sync", "GET /api/tasks",
// "tasks"), reduced to a restricted alphabet: no space, so no
// `from <name>` inside it can ever look like a read clause to the read-set
// capture (`extractReadTablesFromSql`, the same reasoning as the read tag's),
// and no `*`, so it can never close its own comment.

const PREFIX = "/* origin=";
const SUFFIX = " */ ";

/** The longest label a comment carries: enough to name the caller, never a payload. */
export const ORIGIN_LABEL_MAX = 120;

const UNSAFE = /[^A-Za-z0-9._:/@=+-]/g;

/** `label` in the comment's alphabet: every other character becomes `_`, cut to {@link ORIGIN_LABEL_MAX}. */
export function originCommentLabel(label: string): string {
  const cut =
    label.length > ORIGIN_LABEL_MAX ? label.slice(0, ORIGIN_LABEL_MAX) : label;
  return cut.replace(UNSAFE, "_");
}

/** `text` with its origin comment in front. */
export function tagSqlWithOrigin(text: string, label: string): string {
  return `${PREFIX}${originCommentLabel(label)}${SUFFIX}${text}`;
}

/** A statement read back: the origin its comment names (null when untagged) and the SQL after it. */
export interface SqlOrigin {
  origin: string | null;
  sql: string;
}

/**
 * Split a statement's text into the origin its leading comment names and the
 * SQL that follows. Untagged text (another pool's, a psql session's) comes
 * back whole, with `origin: null`.
 */
export function parseSqlOrigin(text: string): SqlOrigin {
  if (!text.startsWith(PREFIX)) return { origin: null, sql: text };
  const end = text.indexOf(SUFFIX, PREFIX.length);
  if (end === -1) return { origin: null, sql: text };
  return {
    origin: text.slice(PREFIX.length, end),
    sql: text.slice(end + SUFFIX.length),
  };
}
