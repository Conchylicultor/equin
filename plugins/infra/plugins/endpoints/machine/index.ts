import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { implementMachine, machineHandler } from "./internal/implement-machine";

export default {
  description:
    "Typed endpoint contract primitive, desktop-only half: implementMachine() creates the server handler of an endpoint declared needsMachine, and machineHandler() brands a raw one — so only a machine/ barrel serves either.",
} satisfies MachinePluginDefinition;
