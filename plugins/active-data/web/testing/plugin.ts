import type { LoadedPlugin } from "@plugins/framework/plugins/web-sdk/core";
import definition from "../index";

export const activeDataPlugin = {
  ...definition,
  id: "active-data",
} as unknown as LoadedPlugin;
