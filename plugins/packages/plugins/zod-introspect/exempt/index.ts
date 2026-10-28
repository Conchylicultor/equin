import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "zod-introspect/no-zod-internals",
    paths: ["core/internal", "lint"],
    kind: "sanctioned",
    reason:
      "The one owner of zod internals: the backend reads `_zod` to build the repo-owned SchemaNode, `inspect` names a zod 3 schema (`_def.typeName`) it refuses, `defineSchemaTag` stamps its tag on a cloned def, the tests pin those shapes, and the lint rule itself spells the zod 3 kind names it bans. Everyone else reads a schema through `inspect`.",
  },
] satisfies Exemptions;
