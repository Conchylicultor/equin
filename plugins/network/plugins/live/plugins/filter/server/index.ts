import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { filterSql, renderOpSql } from "./internal/render";

export default {
  description:
    "The filter language's SQL half: renderOpSql renders one op's dialect-free template over a rendered target (operands as params cast to the domain's SQL type, lists as ONE array param), and filterSql compiles a whole and/or Filter tree over a column → rendered-SQL target map.",
} satisfies ServerPluginDefinition;
