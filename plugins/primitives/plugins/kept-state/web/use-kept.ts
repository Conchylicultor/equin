import { useCallback } from "react";
import {
  useStore,
  type Store,
} from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { viewPoolStore, type KeptView, type KeptWork } from "./define-kept";
import { useKeepScope, viewEntryId } from "./keep-scope";
import type { KeptBinding } from "../core";
import { useKeptEntry } from "./use-draft";

const asStored = <T>(stored: unknown): T => stored as T;

/**
 * Read and write a piece of kept state (`defineKept`) as a `useState` drop-in:
 * `[value, set, clear, handle]` — `handle` is for `submitKept`.
 *
 * - **Work** belongs to what it is about, not to the pane showing it, so
 *   `subject` (a conversation id, a task id, a block id) is required: two panes
 *   on one conversation share its draft.
 * - **View** is keyed by the place it renders in — the ambient `KeepScope`
 *   (the pane instance, else the tab) — and dropped when that place closes.
 *   Outside every `KeepScope` it is held in memory only. Several instances
 *   of one owner in the same place (two lists, one selection each) tell
 *   themselves apart by `key` — stable across a reload, unique among that
 *   owner's instances in the place (a list's name, a section's id). A
 *   `null` key holds that instance in memory only — for a primitive whose
 *   callers opt into keeping (a collapsible given no id).
 */
export function useKept<T>(
  kept: KeptWork<T>,
  initialValue: T | (() => T),
  options: { subject: string },
): KeptBinding<T>;
export function useKept<T>(
  kept: KeptView<T>,
  initialValue: T | (() => T),
  options?: { key: string | null },
): KeptBinding<T>;
export function useKept<T>(
  kept: KeptWork<T> | KeptView<T>,
  initialValue: T | (() => T),
  options?: { subject: string } | { key: string | null },
): KeptBinding<T> {
  // Both arms call the same hooks in the same order, whatever the tier.
  const workStore = useStore(
    kept.tier === "work" ? kept.store : viewPoolStore(),
  ) as Store<unknown>;
  const path = useKeepScope();
  const schema = kept.tier === "view" ? kept.schema : null;
  const parseView = useCallback(
    (stored: unknown): T | null => {
      if (schema === null) return stored as T;
      // Best effort: an entry its schema no longer reads (another build's) is
      // not restored; the next write replaces it.
      const parsed = schema.safeParse(stored);
      return parsed.success ? parsed.data : null;
    },
    [schema],
  );
  const subject =
    options !== undefined && "subject" in options ? options.subject : undefined;
  const key =
    options !== undefined && "key" in options ? options.key : undefined;
  if (kept.tier === "work" && subject === undefined)
    throw new Error(
      `useKept: work owner "${kept.owner}" needs a subject (what the work is about)`,
    );
  if (key === "")
    throw new Error(`useKept: view owner "${kept.owner}" got an empty key`);
  const work = kept.tier === "work";
  const store = work || (path !== null && key !== null) ? workStore : null;
  const id = work
    ? (subject ?? "")
    : path === null || key === null
      ? ""
      : viewEntryId(path, kept.owner, key);
  return useKeptEntry<T>(
    store,
    id,
    initialValue,
    work ? asStored<T> : parseView,
  );
}
