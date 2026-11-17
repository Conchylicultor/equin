import { z } from "zod";
import {
  clearDraft,
  defineKept,
  readDraft,
  writeDraft,
} from "@plugins/primitives/plugins/kept-state/web";
import type { Store } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { getTabId } from "@plugins/primitives/plugins/scope/plugins/tab-id/web";

/**
 * Text typed into an editable field and not acked yet: the text, the value it
 * was typed over, and the browser tab that typed it.
 */
export interface PendingText {
  text: string;
  base: string;
  tab: string;
}

/**
 * Every editable field's pending text — work: what the user typed and the
 * server has not acked. One entry per `<field>|<subject>`, cleared once a save
 * of it resolves (or the user takes the other side of a conflict).
 */
export const pendingText = defineKept<PendingText>({
  owner: "editable-field.pending",
  label: "Unsaved field edits",
  tier: "work",
  cap: "64 KB",
  schema: z.object({ text: z.string(), base: z.string(), tab: z.string() }),
});

type PendingStore = Store<PendingText>;

/**
 * Mounted fields per entry, in this page. Two panes on one task title share
 * the entry; only a field mounting while NO other one holds it restores it
 * (a reload, a tab switch) — a second pane opening beside the one being typed
 * in must not adopt (and re-save) the first one's in-flight text.
 */
const holders = new Map<string, number>();

/** Count this field as holding `id` while mounted (an effect's body). */
export function holdPending(id: string): () => void {
  holders.set(id, (holders.get(id) ?? 0) + 1);
  return () => {
    const left = (holders.get(id) ?? 1) - 1;
    if (left === 0) holders.delete(id);
    else holders.set(id, left);
  };
}

/**
 * What a mounting field takes back: this tab's own unsaved text, when no
 * other mounted field holds the entry. An entry the source already holds is
 * dropped. Another tab's entry is left to that tab (it may still be typing).
 */
export function restorePending(
  store: PendingStore,
  id: string,
  value: string,
): PendingText | null {
  if ((holders.get(id) ?? 0) > 0) return null;
  const held = readDraft(store, { scope: id });
  if (held === null || held.tab !== getTabId()) return null;
  if (held.text === value) {
    clearDraft(store, { scope: id });
    return null;
  }
  return held;
}

/** Keep `text`, typed over `base`, as this tab's pending text. */
export function writePending(
  store: PendingStore,
  id: string,
  text: string,
  base: string,
): void {
  writeDraft(store, { text, base, tab: getTabId() }, { scope: id });
}

/**
 * Clear the entry only while it still holds `mine` — what this field wrote or
 * restored. Another field's text (typed since, in another pane) is never
 * cleared by this one's adopt or save.
 */
export function clearPendingIfMine(
  store: PendingStore,
  id: string,
  mine: string,
): void {
  const held = readDraft(store, { scope: id });
  if (held !== null && held.text === mine && held.tab === getTabId())
    clearDraft(store, { scope: id });
}
