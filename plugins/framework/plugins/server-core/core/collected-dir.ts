import { defineCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";
export const serverCollectedDir = defineCollectedDir("server");
// A plugin's desktop-only backend half: booted in the same graph as the server
// entries (`machineEntries`, nodes keyed `<pluginPath>#machine`).
export const machineCollectedDir = defineCollectedDir("machine");
