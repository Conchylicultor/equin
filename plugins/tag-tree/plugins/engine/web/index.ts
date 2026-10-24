import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useTagTree, useTagTreeActions } from "./internal/use-tag-tree";
export type { TagTreeActions } from "./internal/use-tag-tree";

export default {
  description:
    "Tag-tree engine (web): useTagTree reads a declared tree live (the whole tree, in rank order) and useTagTreeActions binds the engine's create / create-path / update / move / delete endpoints to it.",
  contributions: [],
} satisfies PluginDefinition;
