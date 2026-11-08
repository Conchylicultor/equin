import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { SETI_SET, readSetiSet } from "./internal/seti-set";

export default {
  description:
    "The vendored Seti file-type set (jesseweed/seti-ui, MIT, one colour), portable: SETI_SET names it, readSetiSet loads it (a lazy JSON module, so a browser host bundles it too). The pure drawing — resolveIcon, resolveSymbol, buildSymbol — is core's; reading the installed Material sets is the machine half's (symbolBody).",
  contributions: [],
} satisfies ServerPluginDefinition;
