import { useCallback, useMemo } from "react";
import { useDraft } from "@plugins/primitives/plugins/persistent-draft/web";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { z } from "zod";
import type { Preset } from "../../core";

/** How one card is being looked at. Absent = the card's defaults. */
export interface CardViewState {
  /** A split id; null = the unsplit total. Absent = the ref's own split. */
  split?: string | null;
  cumulative?: boolean;
  table?: boolean;
}

/**
 * How a board view is being looked at — device-local, never part of the
 * authored spec (which holds only WHAT the board shows).
 */
export interface BoardViewState {
  preset: Preset;
  compare: boolean;
  /** Section id → the metric id of its selected focus tile. */
  selected: Record<string, string>;
  /** `cardKey` → that card's controls. */
  cards: Record<string, CardViewState>;
}

const INITIAL: BoardViewState = {
  preset: "30d",
  compare: false,
  selected: {},
  cards: {},
};

/** A year: the look of a board is a preference, not a draft about to expire. */
const boardViewStore = defineStore<BoardViewState>({
  owner: "metrics.board-view",
  label: "Metrics board views",
  area: "local",
  cap: "64 KB",
  ttl: 365 * 24 * 60 * 60 * 1000,
  whenFull: "evict-oldest",
  schema: z.object({
    preset: z.enum(["7d", "30d", "90d", "1y"]),
    compare: z.boolean(),
    selected: z.record(z.string(), z.string()),
    cards: z.record(
      z.string(),
      z.object({
        split: z.string().nullable().optional(),
        cumulative: z.boolean().optional(),
        table: z.boolean().optional(),
      }),
    ),
  }),
  // No `legacy`: the old key was `${storageKey}:${viewId}` with no fixed
  // prefix this module owns, so the old entries are not carried over.
});

export interface BoardViewStateHandle {
  state: BoardViewState;
  setPreset: (preset: Preset) => void;
  setCompare: (compare: boolean) => void;
  select: (sectionId: string, metricId: string) => void;
  setCard: (key: string, patch: CardViewState) => void;
}

export function useBoardViewState(key: string): BoardViewStateHandle {
  const [stored, setState] = useDraft(boardViewStore, INITIAL, {
    scope: key,
  });
  // A stored value from an older shape still reads as a whole state.
  const state = useMemo(() => ({ ...INITIAL, ...stored }), [stored]);
  const setPreset = useCallback(
    (preset: Preset) => setState((s) => ({ ...INITIAL, ...s, preset })),
    [setState],
  );
  const setCompare = useCallback(
    (compare: boolean) => setState((s) => ({ ...INITIAL, ...s, compare })),
    [setState],
  );
  const select = useCallback(
    (sectionId: string, metricId: string) =>
      setState((s) => ({
        ...INITIAL,
        ...s,
        selected: { ...s.selected, [sectionId]: metricId },
      })),
    [setState],
  );
  const setCard = useCallback(
    (cardKey: string, patch: CardViewState) =>
      setState((s) => ({
        ...INITIAL,
        ...s,
        cards: { ...s.cards, [cardKey]: { ...s.cards?.[cardKey], ...patch } },
      })),
    [setState],
  );
  return { state, setPreset, setCompare, select, setCard };
}
