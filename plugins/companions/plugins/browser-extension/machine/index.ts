import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { DocumentHead } from "@plugins/shell/plugins/document-head/server";
import {
  browserExtensionApp,
  EXTENSION_ORIGIN,
  recordExtensionOpen,
} from "../core";
import {
  browserExtensionWatcher,
  connectionServed,
  handleRecordOpen,
  shellServed,
} from "./internal/shell-served";

export default {
  description:
    "The browser extension on the computer: the browser-extension.shell live value (the shell this namespace's build wrote — its digest and the folder Chrome loads it from — pushed when a build rewrites it, through a watch on its digest file) and browser-extension.connection (when the popup last opened, and on which shell), with the endpoint the popup records each open through; and the panel's framing policy (DocumentHead.FrameAncestors): only the extension's own origin may frame /home/browser-extension.",
  register: [browserExtensionWatcher],
  contributions: [
    ...shellServed.declare,
    ...connectionServed.declare,
    // Only the extension's popup frames the panel. The bridge already refuses
    // a port from any other parent; this keeps another page from framing it
    // at all (clickjacking the Wish field, reading its size changes).
    DocumentHead.FrameAncestors({
      id: "browser-extension",
      path: browserExtensionApp.basePath,
      ancestors: [EXTENSION_ORIGIN],
    }),
  ],
  httpRoutes: {
    [recordExtensionOpen.route]: handleRecordOpen,
  },
} satisfies MachinePluginDefinition;
