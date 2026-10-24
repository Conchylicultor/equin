import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { hostAccountServed } from "./internal/served";

export { HostAccountSource } from "./internal/source";
export type { HostAccountSourceImpl } from "./internal/source";

export default {
  portable: true,
  description:
    "Host account: serves the host-account value — the account this instance runs as (login name and full name), read once through the HostAccountSource host service: the OS account on the desktop (machine/), a fixed guest account on a host without the computer. Its sibling host-account.home, the account's home directory, is the machine half's.",
  contributions: [...hostAccountServed.declare],
} satisfies ServerPluginDefinition;
