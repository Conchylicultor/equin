import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

// For a surface that shows one entry it knows by (kind, name) — an automation
// showing its own job's next run and Run now: the entry read across both halves
// of the catalog, and the countdown to a scheduled run.
export { useEntry as useBackgroundEntry } from "./internal/use-entries";
export { NextRun } from "./components/next-run";
// The list and the entry detail, mounted as panes by Debug → Background
// activity (debug/background). The catalog itself names no app: it is infra
// every backend with a job depends on.
export { BackgroundView } from "./components/background-view";
export { EntryDetail } from "./components/entry-detail";

export default {
  description:
    "Background activity catalog, browser half: the live read of one entry across both halves of the catalog, the countdown to its next run, and the catalog list (a DataView grouped by kind, with status, trigger in words, next and last run) and entry detail (scope, declaring plugin, recent runs, Run now) components — mounted as panes by Debug → Background activity.",
  contributions: [],
} satisfies PluginDefinition;
