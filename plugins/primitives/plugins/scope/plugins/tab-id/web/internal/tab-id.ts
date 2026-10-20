import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";

const LEGACY_KEY = "singularity.tabId";

const tabIdStore = defineStore({
  owner: "scope.tab-id",
  label: "Tab ids",
  area: "session",
  cap: "1 KB",
  ttl: Infinity,
  whenFull: "refuse",
  schema: z.string(),
  // The id predates the primitive as a bare string under this key; carrying it
  // over keeps every instance-scoped key of a live tab pointing at the same id.
  legacy: {
    match: (key) => key === LEGACY_KEY,
    adopt: (_key, raw) => (raw ? { id: "", value: raw, ts: Date.now() } : null),
  },
});

/** Stable per-browser-tab id; a stable sentinel when session storage is unavailable. */
export function getTabId(): string {
  const read = tabIdStore.read();
  if (read.kind === "value") return read.value;
  // Storage blocked (disabled, private mode): degrade to a stable sentinel so
  // attribution never throws in a caller's hot path.
  if (read.why === "unavailable") return "no-tab-id";
  const id = crypto.randomUUID();
  return tabIdStore.write("", id).ok ? id : "no-tab-id";
}
