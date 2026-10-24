import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { IdKinds } from "@plugins/ids/web";
import { prototypeTagIdKind } from "../core";

export {
  usePrototypeState,
  usePrototypeStates,
  useSetPrototypeState,
} from "./internal/use-prototype-state";

export default {
  description:
    "Per-instance prototype state, web half: registers the prototype tag id kind (`prtag-…`), and the hooks reading and writing a prototype's pinned / Done / tag state (usePrototypeStates, usePrototypeState, useSetPrototypeState).",
  contributions: [IdKinds.Kind({ kind: prototypeTagIdKind })],
} satisfies PluginDefinition;
