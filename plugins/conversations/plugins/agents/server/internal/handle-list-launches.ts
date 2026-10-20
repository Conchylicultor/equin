import { implement } from "@plugins/infra/plugins/endpoints/server";
import { listAgentLaunches } from "../../core/endpoints";
import { agentLaunchRowsServed } from "./resources";

// One agent's launches, read THROUGH the served `agent-launches` set
// (`agentLaunchRowsServed`), so this endpoint, the HTTP twin of that
// collection, cannot derive a launch's latest conversation, project or order
// its rows differently: the latest conversation is the
// `task_latest_conversation` rollup's (`./agent-launch-rows.ts`), the order
// `createdAt` ascending. The set is whole (no per-agent scope) and small —
// one row per agent launch — so the agent's slice is filtered here.
export const handleListLaunches = implement(
  listAgentLaunches,
  async ({ params }) => {
    const launches = await agentLaunchRowsServed.all.load({});
    return launches.filter((l) => l.agentId === params.id);
  },
);
