import { sql } from "drizzle-orm";
import { expr } from "@plugins/infra/plugins/query-resource/core";
import type { ServeAllCollectionOptions } from "@plugins/network/plugins/live/server";
import type { Agent } from "../../core";
import { _agents } from "./tables";

// How `agentRows` (shared: the whole ordered roster, key `agents.roster`)
// binds to the database — the ONE spelling both the served collection
// (`./resources.ts`) and the tests (`./agents-roster-oracle.test.ts`, which
// compiles it against a throwaway database and holds it equal to `agents_v`)
// read, so neither can drift from what ships.
//
// It reads the `agents` TABLE alone, never `agents_v` (a routed compile reads
// base tables): every row field binds to its column by name, and `isFolder`
// is `prompt IS NULL` — the definition `agents_v.is_folder` spells. So an
// agent write is its own row's refill (every column is a field), a `rank`
// move adds one `orderOf`, an insert is an entrant and a delete an exit.

const columns = {
  isFolder: (j: { base: { prompt: unknown } }) =>
    expr(sql`(${j.base.prompt} IS NULL)`, {
      decoder: Boolean,
      sqlType: "boolean",
      notNull: true,
    }),
};

export const agentRowsServeOptions = {
  from: _agents,
  columns,
} satisfies ServeAllCollectionOptions<typeof _agents, Agent>;
