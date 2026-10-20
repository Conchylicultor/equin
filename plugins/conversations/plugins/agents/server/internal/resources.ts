import { serveCollection } from "@plugins/network/plugins/live/server";
import { agentRowsServeOptions } from "./agent-rows";
import { agentLaunchRowsServeOptions } from "./agent-launch-rows";
// `key` / `schema` come from the shared declarations — the single source of
// truth both runtimes read; the server adds only the DB half.
import { agentRows, agentLaunchRows } from "../../core";

// The whole ordered roster and its `:rows` point sibling, routed over the
// `agents` table (`./agent-rows.ts`). Persisted to L2, so the `{}` snapshot
// stays current with nobody subscribed.
export const agentRowsServed = serveCollection(
  agentRows,
  agentRowsServeOptions,
);

// The whole ordered set of launches and its `:rows` point sibling, routed over
// `agent_launches` and the `task_latest_conversation` rollup's two sources
// (`./agent-launch-rows.ts`). Persisted to L2, so the `{}` snapshot stays
// current with nobody subscribed.
export const agentLaunchRowsServed = serveCollection(
  agentLaunchRows,
  agentLaunchRowsServeOptions,
);
