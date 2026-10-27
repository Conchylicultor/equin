import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { createPrototype } from "../core";
import { PrototypeHistoryStore } from "../server";
import { handleCreate } from "./internal/create";
import { gitHistory } from "./internal/history-provider";

export default {
  description:
    "Prototype files, desktop half: provides the PrototypeHistoryStore host service as one private git repo per prototype under _history/ (the store ./equin prototype log|checkpoint|restore read too), and mints new prototypes from the running checkout's prototypes/_template/ (POST /api/prototypes, needsMachine).",
  contributions: [PrototypeHistoryStore.provide(gitHistory)],
  httpRoutes: {
    [createPrototype.route]: handleCreate,
  },
} satisfies MachinePluginDefinition;
