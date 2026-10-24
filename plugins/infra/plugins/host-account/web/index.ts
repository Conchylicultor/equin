import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useHostAccount } from "./internal/use-host-account";

export default {
  description:
    "Host account, read: useHostAccount() — the account this instance runs as (login name and full name: the OS account on the desktop, a guest account on a host without the computer), loading until its value arrives. Its home directory is the hostHome value (core, needsMachine), read with useLive.",
  contributions: [],
} satisfies PluginDefinition;
