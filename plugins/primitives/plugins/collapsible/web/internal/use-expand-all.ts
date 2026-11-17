import { useCallback, useMemo } from "react";
import { z } from "zod";
import {
  defineKept,
  useKept,
} from "@plugins/primitives/plugins/kept-state/web";

export interface UseExpandAllReturn {
  expanded: ReadonlySet<string>;
  allExpanded: boolean;
  toggleAll: () => void;
  toggle: (id: string) => void;
}

const keptExpanded = defineKept({
  owner: "collapsible.expand-all",
  tier: "view",
  schema: z.array(z.string()),
});

const NONE: string[] = [];

/**
 * Which of `ids` are expanded, with a toggle each and one for all. Kept as
 * view state of the place this renders in under `keep` — an id stable across
 * a reload, unique among the expand-all lists of one place — so a remount, a
 * tab switch or a reload gives it back. An expanded id no longer in `ids` is
 * harmless: it is never drawn.
 */
export function useExpandAll(
  ids: readonly string[],
  { keep }: { keep: string },
): UseExpandAllReturn {
  const [kept, setKept] = useKept(keptExpanded, NONE, { key: keep });
  const expanded = useMemo<ReadonlySet<string>>(() => new Set(kept), [kept]);

  const allExpanded = ids.length > 0 && ids.every((id) => expanded.has(id));

  const toggleAll = useCallback(() => {
    setKept((prev) => {
      const all = ids.length > 0 && ids.every((id) => prev.includes(id));
      return all ? [] : [...ids];
    });
  }, [ids, setKept]);

  const toggle = useCallback(
    (id: string) => {
      setKept((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
      );
    },
    [setKept],
  );

  return { expanded, allExpanded, toggleAll, toggle };
}
