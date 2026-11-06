import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { symbolBody } from "./internal/resolve-icon";
export { SETI_SET, readSetiSet } from "./internal/seti-set";

export default {
  description:
    "Reads glyphs out of the installed Iconify JSON (the pure drawing — resolveIcon, resolveSymbol, buildSymbol — is core's): symbolBody (one Material Symbols glyph in a style, for a consumer with no sprite sheet — the release CLI's app icon); SETI_SET / readSetiSet expose the vendored Seti file-type set (jesseweed/seti-ui, MIT, one colour).",
  contributions: [],
} satisfies ServerPluginDefinition;
