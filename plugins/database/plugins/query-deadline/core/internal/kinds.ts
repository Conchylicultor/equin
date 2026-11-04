// The report kind strings, spelled once. The server registers its
// `ReportKind` under them and the web dispatches its `Reports.KindView` on them;
// a second spelling on either side would leave the other silently unmatched
// (the list would fall back to the bare message, the report to "unknown kind").

/** One query got no answer before its deadline; its connection was closed. */
export const DB_QUERY_DEADLINE_KIND = "db-query-deadline";

/**
 * RETIRED: the process abandoned more connections than its hold set was sized
 * for. Nothing files it since lost connections are closed (2026-11-04); kept
 * registered so existing rows still render and can be investigated.
 */
export const DB_ABANDON_CAP_KIND = "db-abandon-cap";
