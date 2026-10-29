import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { SavedThemeSchema } from "./saved-theme";

/**
 * Every saved theme (tweakcn imports and custom themes), oldest first — the
 * resident theme source the painter resolves each scope's selection against.
 *
 * The WHOLE list, not a window: the painter must hold every saved theme to
 * paint whichever one a scope selects (and the one it `extends`). It grows only
 * by a hand-made save or import (single digits in practice), so it stays small.
 *
 * `boot-and-keep`: hydrated by the boot snapshot before first paint, so the
 * first injection paints the selected theme, and never collected.
 *
 * A write answers its commit's ack token (`SavedThemeWrite`); a caller waits
 * for this list to have re-read it with `useAwaitSavedThemesWrite` (web).
 */
export const savedThemesList = liveValue("saved-themes.list", {
  schema: wholeList(SavedThemeSchema, {
    reason:
      "every saved theme: the painter needs all of them resident to paint any selection, and the list grows only by a hand-made save or import (single digits in practice)",
  }),
  preload: "boot-and-keep",
});
