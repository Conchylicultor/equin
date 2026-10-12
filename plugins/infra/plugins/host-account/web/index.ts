import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useHostAccount } from "./internal/use-host-account";

export default {
  description:
    "Host account, read: useHostAccount() — the OS account this backend runs as (login name and full name), loading until its value arrives. Its home directory is the hostHome value (core), read with useLive.",
  contributions: [],
} satisfies PluginDefinition;
