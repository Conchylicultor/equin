import { serveValue } from "@plugins/network/plugins/live/server";
import { savedThemesList } from "../../core";
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
  loader: listSavedThemes,
});
