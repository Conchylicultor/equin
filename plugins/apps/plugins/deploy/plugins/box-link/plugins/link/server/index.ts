import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { DbTrigger } from "@plugins/database/plugins/db-triggers/server";
import { boxLinkTargetTriggers } from "./internal/targets-notify";

export {
  onBoxHello,
  onBoxSignal,
  type BoxHelloHandler,
  type BoxSignalHandler,
} from "../shared/signals";
export { onLinkTargetsChanged } from "./internal/targets-notify";
export {
  readKeptBoxLinks,
  writeBoxLinkState,
  type KeptBoxLink,
} from "./internal/persist";

export default {
  description:
    "The box link's portable half: onBoxSignal(source, fn) — a linked box's signals, the payload the source's own vocabulary — and onBoxHello(fn) — every (re)connect, the catch-up cue; the deploy_deployments_ext_box_link side-table (a link's record at its last state change, read back at boot: readKeptBoxLinks / writeBoxLinkState); and onLinkTargetsChanged(fn), a NOTIFY rung by a statement trigger on the deployments, servers, server-health (pinned host key) and stand-in tables. The links themselves live in the machine half.",
  contributions: [DbTrigger(boxLinkTargetTriggers)],
} satisfies ServerPluginDefinition;
