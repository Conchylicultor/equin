import type { LoadedPlugin } from "@plugins/framework/plugins/web-sdk/core";
import definition from "../index";

export const goPlugin = {
  ...definition,
  id: "active-data.go",
} as unknown as LoadedPlugin;
