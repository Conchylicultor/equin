import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { homeFolderConfig, profileNameConfig } from "../core";
import { hostAccountServed } from "./internal/served";

export { HostAccountSource } from "./internal/source";
export type { HostAccountSourceImpl } from "./internal/source";

export default {
  description:
    "Host account: serves the host-account value — the account this instance runs as (login name and full name), read once through the HostAccountSource host service: the OS account on the desktop (machine/), a fixed guest account on a host without the computer. Its sibling host-account.home, the account's home directory, is the machine half's. Registers the profile-name setting (the name shown for the user, or none).",
  contributions: [
    ...hostAccountServed.declare,
    ConfigV2.Register({ descriptor: profileNameConfig }),
    ConfigV2.Register({ descriptor: homeFolderConfig }),
  ],
} satisfies ServerPluginDefinition;
