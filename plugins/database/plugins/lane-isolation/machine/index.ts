import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";

export default {
  description:
    "The end-to-end proof that the app's connection lanes are isolated all the way down to PgBouncer: with every background server slot of a throwaway database held idle in a transaction (the 2026-11-03 shape), interactive queries still answer. Test only — a child of database so it can use the throwaway-database fixture, which itself depends on database.",
} satisfies MachinePluginDefinition;
