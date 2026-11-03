// Read aliases: the table name a reader guesses, answering with the view.
//
// A derived view named `<table>_v` enriches the physical `<table>` with its
// computed columns (`tasks_v` adds `status`, `active`, …), and every row of the
// table is a row of the view. The code names the view's drizzle object after the
// table (`export const tasks = pgView("tasks_v")`) and its row type carries the
// computed columns, so someone writing raw SQL — an agent through `query_db` —
// writes `SELECT status FROM tasks` and hits "column status does not exist".
//
// The table and the view cannot share a name in `public`, and Postgres has no
// synonyms, so the aliases live in their own schema: `agent_read.tasks` is
// `SELECT * FROM public.tasks_v`. A reader that puts it first on its
// `search_path` gets the view under the table's name; `public.tasks` still
// reaches the table. Nothing else sets that search_path, so the app's own SQL
// is untouched.
//
// The schema is derived code, wholly owned by the derived-views layer: dropped
// and recreated with the views (`rebuildDerivedViews`, `dropDerivedViews`),
// never in the migration chain. It holds only views, so a fork copies no rows
// for it and no fork exclusion has to claim it.

/** The schema holding one alias view per `<table>_v` view over a `<table>` table. */
export const READ_ALIAS_SCHEMA = "agent_read";

const ALIAS_SUFFIX = "_v";

/**
 * The table name a derived view is the enriched read of — `tasks` for
 * `tasks_v` — or `undefined` for a view not named after a table this way. The
 * caller still checks that the table exists (`task_blocking_v` has no
 * `task_blocking`).
 */
export function readAliasStem(viewName: string): string | undefined {
  if (!viewName.endsWith(ALIAS_SUFFIX)) return undefined;
  const stem = viewName.slice(0, -ALIAS_SUFFIX.length);
  return stem.length > 0 ? stem : undefined;
}
