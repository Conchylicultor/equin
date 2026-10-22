import { serveValue } from "@plugins/network/plugins/live/server";
import { savedThemesList } from "../../shared/resources";
import { _savedThemes } from "./tables";
import { listSavedThemes } from "./store";

// Push over `saved_themes`: a write to it recomputes the list on the next
// flush (the declared `reads`); the change feed's frame carries the write's
// ackTx, which `useAwaitSavedThemesWrite` (web) waits on.
export const savedThemesListServed = serveValue(savedThemesList, {
  source: "db",
  reads: {
    tables: [_savedThemes],
    reason: "the list is every saved theme, so a write to any row changes it",
  },
  unbounded: {
    reason:
      "every saved theme: the painter needs all of them resident to paint any selection, and the list grows only by a hand-made save or import (single digits in practice)",
  },
  loader: listSavedThemes,
});
