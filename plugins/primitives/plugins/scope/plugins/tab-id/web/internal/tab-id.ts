import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { claimTabPresence } from "./presence";

const LEGACY_KEY = `${LEGACY_IDS.browserKeyPrefix}.tabId`;

const tabIdStore = defineStore({
  owner: "scope.tab-id",
  pageWide: {
    reason: "the browser tab's own id, the same for every scope it renders",
  },
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

/**
 * What `getTabId()` answers when session storage cannot hold an id: shared by
 * EVERY such tab, so it names no one tab — a consumer that counts per tab
 * treats it as "client unknown".
 */
export const NO_TAB_ID = "no-tab-id";

/**
 * Stable per-browser-tab id; a stable sentinel (`NO_TAB_ID`) when session storage is
 * unavailable. Reading it also marks this page present under it (see
 * `useTabPresence`): whatever the id is stamped on, another page can then ask
 * whether the tab it names is still open.
 */
export function getTabId(): string {
  const id = readTabId();
  claimTabPresence(id);
  return id;
}

function readTabId(): string {
  const read = tabIdStore.read();
  if (read.kind === "value") return read.value;
  // Storage blocked (disabled, private mode): degrade to a stable sentinel so
  // attribution never throws in a caller's hot path.
  if (read.why === "unavailable") return NO_TAB_ID;
  const id = crypto.randomUUID();
  return tabIdStore.write("", id).ok ? id : NO_TAB_ID;
}
