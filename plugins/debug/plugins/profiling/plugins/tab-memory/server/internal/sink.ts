import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";

/** The log channel every page's samples land in, on the server it talks to. */
export const TAB_MEMORY_CHANNEL = "tab-memory";

export const tabMemorySink = defineLogSink({
  id: TAB_MEMORY_CHANNEL,
  description:
    "PERF sink: each browser page's reading of itself every 5 minutes — JS heap, DOM nodes, canvases, images, its open in-app tabs and route — for Debug → Tab memory, beside main's health-owners renderer sizes.",
});
