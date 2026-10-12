import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { hostAccountServed } from "./internal/served";
import { hostHomeServed } from "./internal/served-home";

export default {
  description:
    "Host account: serves the host-account value — the OS account this backend runs as (login name, and its full name read once through spawnCaptured: macOS `id -F`, the passwd GECOS field elsewhere) — and its sibling host-account.home, the account's home directory.",
  contributions: [...hostAccountServed.declare, ...hostHomeServed.declare],
} satisfies ServerPluginDefinition;
