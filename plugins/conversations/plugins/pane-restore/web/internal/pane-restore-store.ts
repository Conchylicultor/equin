import { z } from "zod";

import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import {
  peekRoute,
  type PaneOptions,
} from "@plugins/primitives/plugins/pane/web";

const DAY = 24 * 60 * 60 * 1000;
const LEGACY_PREFIX = "route.restore.";

// `options` mirrors PaneSlot.options (the opener-supplied partial). Persisted via
// JSON, which round-trips booleans/numbers/nested objects — so it is the
// structured PaneOptions bag (an open record), not a string map. A pane's `hint`
// is deliberately absent: an optimistic mirror of server-owned state must not
// outlive the navigation that created it (see `Hint`).
type SavedSlot = {
  paneId: string;
  params: Record<string, string>;
  options?: PaneOptions;
};

const savedSlotsSchema = z.array(
  z.object({
    paneId: z.string(),
    params: z.record(z.string(), z.string()),
    options: z.record(z.string(), z.unknown()).optional(),
  }),
) satisfies ZodParser<SavedSlot[]>;

const paneRoutes = defineStore({
  owner: "conversations.pane-restore",
  label: "Conversation layouts",
  area: "local",
  cap: "256 KB",
  ttl: 30 * DAY,
  whenFull: "evict-oldest",
  schema: savedSlotsSchema,
  legacy: {
    match: (key) => key.startsWith(LEGACY_PREFIX),
    adopt: (key, raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        if (err instanceof SyntaxError) return null;
        throw err;
      }
      if (typeof parsed !== "object" || parsed === null) return null;
      const env = parsed as { v?: unknown; ts?: unknown };
      if (typeof env.ts !== "number") return null;
      return { id: key.slice(LEGACY_PREFIX.length), value: env.v, ts: env.ts };
    },
  },
});

// `restored` carries the saved layout; `none` means there is nothing to restore
// (absent, expired, unreadable — the store drops and reports an unreadable
// entry itself — or storage unavailable).
export type RouteRestore =
  { kind: "restored"; slots: SavedSlot[] } | { kind: "none" };

export function saveRouteForConversation(
  convId: string,
  slots: SavedSlot[],
): void {
  // A refused write is reported by the store itself.
  paneRoutes.write(convId, slots);
}

export function loadRouteForConversation(convId: string): RouteRestore {
  const read = paneRoutes.read(convId);
  return read.kind === "value"
    ? { kind: "restored", slots: read.value }
    : { kind: "none" };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function handleNavigation(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const route = peekRoute();
    if (route.length === 0 || route[0]?.paneId !== "conversation") return;
    const convId = route[0]?.params.convId;
    if (!convId) return;
    const slots: SavedSlot[] = route.map((s) => ({
      paneId: s.paneId,
      params: s.params,
      options: s.options,
    }));
    saveRouteForConversation(convId, slots);
  }, 50);
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", handleNavigation);
  window.addEventListener("shell:navigate", handleNavigation);
}
