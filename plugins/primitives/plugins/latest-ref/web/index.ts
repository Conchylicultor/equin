import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useLatestRef, useEventCallback } from "./internal/latest-ref";
export { useLatestStore, useLatestSelector } from "./internal/latest-store";
export type { LatestStore } from "./internal/latest-store";

export default {
  description:
    "Latest-value ref idiom as a primitive: useLatestRef(value) mirrors the latest value into a ref written in render (read only in callbacks/effects), useEventCallback(fn) is the stable-identity callback built on it, and useLatestStore(value) / useLatestSelector(store, select) hand a per-render value down to many memoized readers, each re-rendering only when its own selected answer changes. The single sanctioned home + exemption for the idiom, so react-hooks/refs can be enforced at error.",
  contributions: [],
} satisfies PluginDefinition;
