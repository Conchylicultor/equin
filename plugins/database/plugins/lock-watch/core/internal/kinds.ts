// The report kind string, spelled once: the server registers its `ReportKind`
// under it, and its payload carries it as `kind`. (No `Reports.KindView`: the
// Reports list shows the report's own message.)

/** A session held others back, or sat idle inside a transaction, past the lock watch's bound. */
export const DB_LOCK_HOLDER_KIND = "db-lock-holder";
