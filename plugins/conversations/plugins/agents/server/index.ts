// Registers the agents' saved-icon source (module eval).
import "./internal/saved-icons";
import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { View } from "@plugins/database/plugins/derived-views/server";
import { DerivedTable } from "@plugins/database/plugins/derived-tables/server";
import { TaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { handleList } from "./internal/handle-list";
import { handleGet } from "./internal/handle-get";
import { handleCreate } from "./internal/handle-create";
import { handleUpdate } from "./internal/handle-update";
import { handleMove } from "./internal/handle-move";
import { handleDelete } from "./internal/handle-delete";
import { handleListLaunches } from "./internal/handle-list-launches";
import { agentLaunchRowsServed, agentRowsServed } from "./internal/resources";
import { agents } from "./internal/views";
import { taskLatestConversation } from "./internal/rollup-spec";
import {
  listAgents,
  createAgent,
  getAgent,
  updateAgent,
  moveAgent,
  deleteAgent,
  listAgentLaunches,
} from "../core";
import { IdKinds } from "@plugins/ids/server";
import { agentIdKind, agentLaunchIdKind } from "../core";

export { _agent_launches, _agents } from "./internal/tables";
export { agents } from "./internal/views";
export {
  AgentSchema,
  AgentLaunchSchema,
  AgentLaunchWithStatusSchema,
} from "./internal/schema";
export type {
  Agent,
  AgentLaunch,
  AgentLaunchWithStatus,
} from "./internal/schema";
export { nextAgentRankUnder } from "./internal/rank";

export default {
  description:
    "Named agent definitions that launch conversations: the agents roster and launches (tables, live collections, CRUD and move routes), portable; the launch route itself is the desktop-only machine half.",
  portable: true,
  httpRoutes: {
    [listAgents.route]: handleList,
    [createAgent.route]: handleCreate,
    [getAgent.route]: handleGet,
    [updateAgent.route]: handleUpdate,
    [moveAgent.route]: handleMove,
    [deleteAgent.route]: handleDelete,
    [listAgentLaunches.route]: handleListLaunches,
  },
  contributions: [
    IdKinds.Kind({ kind: agentIdKind }),
    IdKinds.Kind({ kind: agentLaunchIdKind }),
    ...agentRowsServed.declare,
    ...agentLaunchRowsServed.declare,
    View({ view: agents }),
    DerivedTable(taskLatestConversation),
    TaskCategory({ id: "agents", label: "Agents", order: 2 }),
  ],
} satisfies ServerPluginDefinition;
