import { getTableColumns, sql } from "drizzle-orm";
import { pgView } from "drizzle-orm/pg-core";
import { _agents } from "./tables";

// Derived (plain) view. Lives in `views.ts` — NOT `schema.ts` — so the drizzle
// codegen glob never sees it: it is rebuilt from source on every boot via the
// `View` server contribution (declared in this plugin's server barrel) +
// rebuildDerivedViews, never tracked in the migration chain. To change it, edit
// here and `./equin build` — no migration is generated.
// See plugins/database/plugins/derived-views/CLAUDE.md.

export const agents = pgView("agents_v").as((qb) =>
  qb
    .select({
      ...getTableColumns(_agents),
      isFolder: sql`(${_agents.prompt} IS NULL)`
        .mapWith(Boolean)
        .as("is_folder"),
    })
    .from(_agents),
);
