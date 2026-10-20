import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";

// The app this browser tab last had focused, kept across a reload so the
// reload's re-publish of the same app is not counted as a launch. Per tab
// (session storage): a new tab starts fresh, and its first app IS a launch.
// When storage is unavailable or refuses the write (reported by the store),
// every first app of a page load counts as a launch - a slight over-count.
const lastAppStore = defineStore({
  owner: "app-usage.last-app",
  label: "Last focused app",
  area: "session",
  cap: "1 KB",
  ttl: Infinity,
  whenFull: "refuse",
  schema: z.string(),
  legacy: {
    match: (key) => key === "app-usage:last-app",
    adopt: (_key, raw) => (raw ? { id: "", value: raw, ts: Date.now() } : null),
  },
});

export function readLastApp(): string | undefined {
  const read = lastAppStore.read();
  return read.kind === "value" ? read.value : undefined;
}

export function writeLastApp(appId: string): void {
  lastAppStore.write("", appId);
}
