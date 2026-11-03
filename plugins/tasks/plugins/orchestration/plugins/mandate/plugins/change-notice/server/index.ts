import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { PendingTurn } from "@plugins/conversations/plugins/automatic-turn/server";
import {
  conversationStatusChanged,
  taskMandateChanged,
} from "@plugins/tasks/plugins/tasks-core/server";
import { noticeTurn } from "./internal/notice";
import { onMandateChangedJob, sendNoticeOnStatusJob } from "./internal/jobs";

export default {
  description:
    "A running agent follows a change of its task's mandate without a restart: on tasks.mandateChanged each live agent on those tasks reconnects the equin MCP server (its tools are the new mandate's at once), then gets the new Mandate section as an automatic event turn — the server instructions are read only at connect. A pending notice (conversation_mandate_notices) is a PendingTurn and is held while the agent cannot take an automatic turn, re-tried on conversation.statusChanged; an agent this backend does not run gets none.",
  contributions: [
    PendingTurn(noticeTurn),
    Trigger({
      on: taskMandateChanged,
      do: onMandateChangedJob,
      with: {},
      oneShot: false,
    }),
    Trigger({
      on: conversationStatusChanged,
      do: sendNoticeOnStatusJob,
      with: {},
      oneShot: false,
    }),
  ],
  register: [onMandateChangedJob, sendNoticeOnStatusJob],
} satisfies ServerPluginDefinition;
