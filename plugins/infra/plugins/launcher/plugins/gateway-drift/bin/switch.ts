// The gateway switch helper: restarts the machine's gateway service onto the
// job main's follow wrote, outside the process tree that restart stops
// (`startGatewaySwitch` in cli/internal/follow.ts says why). Started detached
// by the follow with the plan file as its one argument; its output is
// state/gateway-follow/switch.log.
import { completeGatewaySwitch } from "@plugins/infra/plugins/launcher/plugins/gateway-drift/cli";

const planFile = process.argv[2];
if (planFile === undefined) {
  throw new Error("usage: switch.ts <plan file>");
}
const log = (line: string) => {
  console.log(`${new Date().toISOString()} ${line}`);
};
await completeGatewaySwitch(planFile, log);
