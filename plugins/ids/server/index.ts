import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { IdKinds, getIdKinds } from "./internal/slots";
export type { IdReferent } from "./internal/slots";
export {
  externalIdColumn,
  idColumn,
  idColumnDeclaration,
  idRef,
} from "./internal/columns";
export type { IdColumnDeclaration } from "./internal/columns";

export default {
  description:
    "The id-kind registry, server half: IdKinds.Kind registers a declared kind and IdKinds.Referent resolves a kind's id to its title; getIdKinds() reads them at call time. idColumn / idRef are a kind's drizzle primary-key and foreign-key columns (typed Id<P>; idRef cascades on update).",
} satisfies ServerPluginDefinition;
