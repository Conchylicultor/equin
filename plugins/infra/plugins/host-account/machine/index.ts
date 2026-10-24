import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { HostAccountSource } from "@plugins/infra/plugins/host-account/server";
import { readHostAccount } from "./internal/read-account";
import { hostHomeServed } from "./internal/served-home";

export default {
  description:
    "Host account, desktop-only half: provides the HostAccountSource host service from the OS account this backend runs as (login name, and its full name read once through spawnCaptured: macOS `id -F`, the passwd GECOS field elsewhere), and serves host-account.home — the account's home directory, declared needsMachine.",
  contributions: [
    HostAccountSource.provide({ read: readHostAccount }),
    ...hostHomeServed.declare,
  ],
} satisfies MachinePluginDefinition;
