import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { IdKinds } from "@plugins/ids/web";
import { turnIdKind } from "../core";

export default {
  description:
    "Registers the turn id kind (turn) with the web id registry — the server barrel registers the same kind.",
  contributions: [IdKinds.Kind({ kind: turnIdKind })],
} satisfies PluginDefinition;
