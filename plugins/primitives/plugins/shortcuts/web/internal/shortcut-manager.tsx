import { useEffect, useMemo } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { Shortcuts } from "../slots";
import { getCachedCombo, matchesEvent } from "./parse-keys";
import { comboIsCommand, targetClaimsKey } from "./target-claims-key";
import { useDynamicShortcuts } from "./dynamic-registry";
import { getFocusedSurfaceId } from "./focused-surface";

export function ShortcutManager() {
  const staticShortcuts = Shortcuts.Shortcut.useContributions();
  const dynamicShortcuts = useDynamicShortcuts();
  // Static path stays byte-identical; the dynamic (surface-scoped) list is
  // simply concatenated to build the active set.
  const shortcuts = useMemo(
    () => [...staticShortcuts, ...dynamicShortcuts],
    [staticShortcuts, dynamicShortcuts],
  );
  const shortcutsRef = useLatestRef(shortcuts);

  useEffect(() => {
    if (import.meta.env.DEV) {
      const byCombo = new Map<string, string[]>();
      for (const s of shortcutsRef.current) {
        const key = s.keys.toLowerCase();
        const ids = byCombo.get(key) ?? [];
        ids.push(s.id);
        byCombo.set(key, ids);
      }
      for (const [combo, ids] of byCombo) {
        if (ids.length > 1) {
          console.warn(
            `[shortcuts] Key combo "${combo}" registered by: ${ids.join(", ")}. ` +
              `Highest priority wins; use "when" guards or distinct priorities to resolve.`,
          );
        }
      }
    }
  }, [shortcuts]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // An element that already handled the key owns it: a tree or list moving
      // its selection with the arrows, a row activated by Space. This window
      // listener runs after React's root-delegated handlers, so their
      // preventDefault is visible here.
      if (e.defaultPrevented) return;
      const active = shortcutsRef.current;
      const editable = targetClaimsKey(e);
      let winner: (typeof active)[number] | null = null;
      let winnerPriority = -Infinity;

      for (const shortcut of active) {
        const parsed = getCachedCombo(shortcut.keys);
        if (!parsed) continue;
        if (!matchesEvent(parsed, e)) continue;
        // While typing, plain-key shortcuts yield to the field so the keystroke
        // is inserted. Commands (Cmd/Ctrl/Alt combos, function keys) never
        // type, so they still fire; a shortcut may opt in via enableInInputs.
        if (editable && !comboIsCommand(parsed) && !shortcut.enableInInputs)
          continue;
        if (shortcut.when && !shortcut.when(e)) continue;
        if (
          shortcut.surfaceId !== undefined &&
          shortcut.surfaceId !== getFocusedSurfaceId()
        )
          continue;

        const priority = shortcut.priority ?? 0;
        if (priority > winnerPriority) {
          winner = shortcut;
          winnerPriority = priority;
        }
      }

      if (winner) {
        e.preventDefault();
        winner.handler();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return null;
}
