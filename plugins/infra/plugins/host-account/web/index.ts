import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { homeFolderConfig, profileNameConfig } from "../core";

export { useHostAccount } from "./internal/use-host-account";
export { useHomeDisplay } from "./internal/use-home-display";
export { useProfileName } from "./internal/use-profile-name";

export default {
  description:
    "Host account, read: useHostAccount() — the account this instance runs as (login name and full name: the OS account on the desktop, a guest account on a host without the computer), loading until its value arrives; useProfileName() — the name to show for the user (the profile-name setting's name, else the account's), or anonymous when the user turned their name off. Registers that setting. Its home directory is the hostHome value (core, needsMachine), read with useLive.",
  contributions: [
    ConfigV2.WebRegister({ descriptor: profileNameConfig }),
    ConfigV2.WebRegister({ descriptor: homeFolderConfig }),
  ],
} satisfies PluginDefinition;
