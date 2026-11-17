import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  NoFreeGatewayPortError,
  chooseGatewayPort,
  describeChoice,
  loadGatewayPortRecord,
  portHolder,
  portIsFree,
  probeGateway,
  resolveGatewayOrigin,
  resolveGatewayPort,
  writeGatewayPortRecord,
} from "./internal/account-port";
export type { GatewayProbe, SkippedPort } from "./internal/account-port";

export default {
  description:
    "This account's gateway port, desktop half (never blocking — a backend may call any of it): the port file read and written (written only once a gateway answers on the port), resolveGatewayPort / resolveGatewayOrigin (the starting gateway's port, else the file, else 9000 for an install that has not moved), the choice of the first free port of 8700…8709 with who holds each taken one, and probeGateway (who answers on a port).",
} satisfies MachinePluginDefinition;
