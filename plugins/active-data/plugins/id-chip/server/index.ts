import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { idChipServer } from "./internal/id-chip-server";

export default {
  description:
    "Id chips, server half: idChipServer({ kind, surfaces, resolve }) contributes the kind's IdKinds.Referent, the InlineTokenReferentSource that hands a model the referent's title, and — for a chip that belongs in documents — the Editor.InlineToken that keeps a page block holding it agent-readable.",
} satisfies ServerPluginDefinition;
