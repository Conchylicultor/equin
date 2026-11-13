import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { recordExtensionOpen } from "../core";
import {
  browserExtensionWatcher,
  connectionServed,
  handleRecordOpen,
  shellServed,
} from "./internal/shell-served";

export default {
  description:
    "The browser extension on the computer: the browser-extension.shell live value (the shell this namespace's build wrote — its digest and the folder Chrome loads it from — pushed when a build rewrites it, through a watch on its digest file) and browser-extension.connection (when the popup last opened, and on which shell), with the endpoint the popup records each open through.",
  register: [browserExtensionWatcher],
  contributions: [...shellServed.declare, ...connectionServed.declare],
  httpRoutes: {
    [recordExtensionOpen.route]: handleRecordOpen,
  },
} satisfies MachinePluginDefinition;
