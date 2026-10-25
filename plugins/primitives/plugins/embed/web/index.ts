import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  embedMode,
  isEmbeddedDocument,
  isChromelessDocument,
  isFramedDocument,
  embedUrl,
} from "./internal/embed-document";
import { embedFocusGuard } from "./internal/focus-guard";

export default {
  description:
    "The declared embedded-document signal: embedMode() reads the `?embed=` flag once at boot (the pane router drops every query on its first write, so it cannot be re-read) — `?embed=1` opens one route with no app chrome, `?embed=chrome` opens the whole app, chrome included — and embedUrl(path, mode) builds an in-app URL that opens that way. isChromelessDocument() is read by the apps layout (no tab bar, no rail) and the floating action bar (hidden); isEmbeddedDocument() by the two sessionStorage writers (app-instance registry, persisted tabs) so a same-origin frame in either mode never evicts the host tab's own state. A framed embed never pulls focus out of its host: its focus() is a no-op until this document has focus (an autofocusing embedded app would otherwise close the host's open popover as its frame loads).",
  register: [embedFocusGuard],
  contributions: [],
} satisfies PluginDefinition;
