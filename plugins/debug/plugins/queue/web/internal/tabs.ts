import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";

/** The queue pane's sections, in switcher order; the first is the default. */
export const QUEUE_TABS = ["jobs", "dead", "events", "triggers"] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];

export const TAB_META: Record<QueueTab, { label: string; icon: IconRef }> = {
  jobs: { label: "Jobs", icon: symbol("work") },
  dead: { label: "Dead", icon: symbol("heart-broken") },
  events: { label: "Events", icon: symbol("bolt") },
  triggers: { label: "Triggers", icon: symbol("call-split") },
};

/**
 * The section a `:tab?` param names. Absent — the bare `/debug/queue` — or a
 * value no section answers to (an old or hand-typed link) opens the default.
 */
export function parseTab(raw: string | undefined): QueueTab {
  return (QUEUE_TABS as readonly string[]).includes(raw ?? "")
    ? (raw as QueueTab)
    : "jobs";
}
