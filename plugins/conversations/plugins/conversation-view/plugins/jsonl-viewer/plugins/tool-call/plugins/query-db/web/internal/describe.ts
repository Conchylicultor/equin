/** The statement on one line, for the card's summary. */
export function compactSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function rowsWords(shown: number, total: number | null): string {
  if (shown === 0 && (total ?? 0) === 0) return "no rows";
  if (total !== null && total > shown)
    return `${shown} of ${total.toLocaleString("en-US")} rows`;
  return `${shown} row${shown === 1 ? "" : "s"}`;
}

/** The card's note: `· 12 rows`, `· 200 of 1,431 rows · equin` (the database
 *  only when the call named one). Undefined when there is nothing to say. */
export function queryNote(
  rows: { shown: number; total: number | null } | undefined,
  database: string | undefined,
): string | undefined {
  const parts = [
    rows ? rowsWords(rows.shown, rows.total) : undefined,
    database,
  ].filter((p) => p !== undefined);
  return parts.length === 0 ? undefined : `· ${parts.join(" · ")}`;
}

/** A cell's text: null as a word, a nested value as JSON. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
