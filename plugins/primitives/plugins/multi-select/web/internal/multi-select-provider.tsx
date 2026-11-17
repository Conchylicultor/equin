import {
  useEffect,
  useMemo,
  useReducer,
  type ReactElement,
  type ReactNode,
} from "react";
import { z } from "zod";
import {
  defineKept,
  useKept,
} from "@plugins/primitives/plugins/kept-state/web";
import {
  initialMultiSelectState,
  MultiSelectContext,
  multiSelectReducer,
  type KeptSelection,
} from "./multi-select-context";

export type MultiSelectProviderProps = {
  /**
   * What this list's selection is kept under: stable across a reload, unique
   * among the multi-select lists of one place (a surface + view id, a page
   * id). The selection is view state of the place it renders in (kept-state's
   * `KeepScope`), so a remount, a tab switch or a reload gives it back; ids
   * whose rows are gone by then are dropped. A new `keep` is a new list: the
   * provider's subtree remounts with that list's own selection.
   *
   * `null`: not kept — a selection bound to focus and gesture state the
   * remount cannot give back (the page editor's block selection), said so
   * at the call site.
   */
  keep: string | null;
  orderedIds: readonly string[];
  children: ReactNode;
};

const keptSelection = defineKept({
  owner: "multi-select.selection",
  tier: "view",
  schema: z.object({
    selected: z.array(z.string()),
    anchor: z.string().nullable(),
  }),
});

const NOTHING_KEPT: KeptSelection = { selected: [], anchor: null };

export function MultiSelectProvider({
  keep,
  ...rest
}: MultiSelectProviderProps): ReactElement {
  return <KeptMultiSelect key={keep ?? ""} keep={keep} {...rest} />;
}

function KeptMultiSelect({
  keep,
  orderedIds,
  children,
}: MultiSelectProviderProps): ReactElement {
  const [kept, setKept] = useKept(keptSelection, NOTHING_KEPT, { key: keep });
  const [state, dispatch] = useReducer(
    multiSelectReducer,
    { kept, orderedIds },
    initialMultiSelectState,
  );

  useEffect(() => {
    dispatch({ type: "SET_ORDERED_IDS", ids: orderedIds });
  }, [orderedIds]);

  // Keep what is selected — but not while kept ids still wait for their rows
  // (what is shown meanwhile is not the whole of the user's selection).
  const { selectedIds, anchorId, restoring } = state;
  useEffect(() => {
    if (restoring !== null) return;
    if (
      kept.anchor === anchorId &&
      kept.selected.length === selectedIds.size &&
      kept.selected.every((id) => selectedIds.has(id))
    )
      return;
    setKept({ selected: [...selectedIds], anchor: anchorId });
  }, [selectedIds, anchorId, restoring, kept, setKept]);

  const ctxValue = useMemo(() => ({ state, dispatch }), [state]);

  return <MultiSelectContext value={ctxValue}>{children}</MultiSelectContext>;
}
