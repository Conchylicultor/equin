import { useMemo } from "react";
import { exitToPreviousMode } from "@plugins/apps-core/plugins/tabs/web";
import {
  createDesktop,
  minimizeAllWindows,
  removeDesktop,
  tileAllWindows,
  toggleOverview,
  useDesktops,
} from "@plugins/apps/plugins/desktop/plugins/windows/web";
import {
  formatShortcutLabel,
  Shortcuts,
} from "@plugins/primitives/plugins/shortcuts/web";
import { symbol, type SymbolRef } from "@plugins/ui/plugins/icons/core";

/** One entry of the launcher's Commands section. */
export interface LauncherCommand {
  /** Unique among the commands; keys the rendered list. */
  id: string;
  label: string;
  icon: SymbolRef;
  /** The shortcut that runs it, formatted for display. */
  hint?: string;
  run(): void;
}

/**
 * The shortcut groups whose entries are window-management commands the launcher
 * lists. The commands are READ from the shortcut registry rather than restated
 * here, so a window action gains a launcher entry by registering a shortcut
 * (and loses it by dropping the shortcut) with no change to this list.
 */
const COMMAND_GROUPS: ReadonlySet<string> = new Set(["Window", "Desktop"]);

const GROUP_ICON: Record<string, SymbolRef> = {
  Window: symbol("web-asset"),
  Desktop: symbol("desktop-windows"),
};

/**
 * The launcher's commands: the registered window / desktop shortcuts (label,
 * keys for display, handler) plus the actions that have no key. A shortcut that
 * shares a label with an earlier entry is dropped — the same action bound to two
 * key spellings (a shifted key some keyboards report differently) lists once.
 */
export function useLauncherCommands(): LauncherCommand[] {
  const shortcuts = Shortcuts.Shortcut.useContributions();
  const { activeDesktopId } = useDesktops();
  return useMemo(() => {
    const keyless: LauncherCommand[] = [
      {
        id: "show-overview",
        label: "Show overview",
        icon: symbol("grid-view"),
        run: toggleOverview,
      },
      {
        id: "tile-all",
        label: "Tile all windows",
        icon: symbol("view-quilt"),
        run: tileAllWindows,
      },
      {
        id: "minimise-all",
        label: "Minimise all windows",
        icon: symbol("remove"),
        run: minimizeAllWindows,
      },
      {
        id: "new-desktop",
        label: "New desktop",
        icon: symbol("add"),
        run: () => createDesktop({ activate: true }),
      },
      {
        id: "close-desktop",
        label: "Close this desktop",
        icon: symbol("close"),
        run: () => removeDesktop(activeDesktopId),
      },
      {
        id: "leave-desktop",
        label: "Leave desktop",
        icon: symbol("logout"),
        run: exitToPreviousMode,
      },
    ];
    const seen = new Set(keyless.map((c) => c.label));
    const registered: LauncherCommand[] = [];
    for (const s of shortcuts) {
      if (s.group === undefined || !COMMAND_GROUPS.has(s.group)) continue;
      if (seen.has(s.label)) continue;
      seen.add(s.label);
      registered.push({
        id: s.id,
        label: s.label,
        icon: GROUP_ICON[s.group]!,
        hint: formatShortcutLabel(s.keys),
        run: s.handler,
      });
    }
    // "Leave desktop" last, after the registered window actions.
    return [
      ...keyless.slice(0, -1),
      ...registered,
      keyless[keyless.length - 1]!,
    ];
  }, [shortcuts, activeDesktopId]);
}
