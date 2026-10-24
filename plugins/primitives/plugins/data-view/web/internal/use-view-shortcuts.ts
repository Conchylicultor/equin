import { useMemo } from "react";
import {
  targetClaimsKey,
  useSurfaceShortcuts,
} from "@plugins/primitives/plugins/shortcuts/web";
import type { ViewModel } from "./use-data-view-model";

/** ⌥1 … ⌥9 — one per view, in the surface's order. */
const MAX_SHORTCUT_VIEWS = 9;

/**
 * ⌥1–⌥9 select the surface's first nine views (`DataViewProps.viewShortcuts`),
 * registered surface-scoped so two surfaces in two tabs never fight over them.
 * `null` (the surface did not ask, or its views are not known yet) registers
 * none.
 *
 * An ⌥-digit is a command to the shortcut registry, which fires it even in a
 * text field — but on macOS ⌥ composes a character there (⌥1 types "¡"), so
 * these yield to any target that takes the key (`targetClaimsKey`).
 */
export function useViewShortcuts(
  storageKey: string,
  viewModel: ViewModel | null,
): void {
  const ready = viewModel?.ready === true ? viewModel : null;
  const instances = ready?.instances;
  const select = ready?.setActiveView;
  const shortcuts = useMemo(
    () =>
      instances === undefined || select === undefined
        ? []
        : instances.slice(0, MAX_SHORTCUT_VIEWS).map((r, index) => ({
            id: `data-view.${storageKey}.view-${index + 1}`,
            keys: `alt+${index + 1}`,
            label: `Show ${r.instance.name}`,
            handler: () => select(r.instance.id),
            when: (event: KeyboardEvent) => !targetClaimsKey(event),
          })),
    [storageKey, instances, select],
  );
  useSurfaceShortcuts(shortcuts);
}
