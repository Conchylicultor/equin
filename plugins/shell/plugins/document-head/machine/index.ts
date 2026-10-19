import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { publishDocumentHead } from "./internal/publish";

export default {
  description:
    "Writes every DocumentHead.Fragment source's answer to the namespace's document-head.json — at boot and on each change — for the gateway to splice into the SPA shell it serves.",
  onReady: publishDocumentHead,
} satisfies MachinePluginDefinition;
