import { db } from "@plugins/database/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  _chordIndexRequest,
  _chordIndexState,
  _chordLoopWindows,
} from "@plugins/apps/plugins/chord/plugins/song-index/server";
import { chordCatalog, chordCurriculum } from "../../core";
import { loadCatalogState } from "./catalog";
import { loadSelection } from "./state";
import { _chordCurriculum } from "./tables";

// What the learner has chosen, pushed again on every change: the change feed
// carries each committed `chord_curriculum` write here (its declared read), and
// the new selection goes to every observing tab.
export const chordCurriculumServed = serveValue(chordCurriculum, {
  source: "db",
  reads: {
    tables: [_chordCurriculum],
    reason: "a singleton row: any write changes the one selection",
  },
  loader: () => loadSelection(db),
});

// The catalog of the song index. The loader reads the index's two state rows
// (`chord_index_state`, `chord_index_request`) every time, so a write to either
// (declared in `reads`) pushes it when a load moves — `not-ready` straight from the status while it
// runs, the catalog once it lands. The window rows it is built from are out
// of the change feed (declared as `outsideFeed`) and read only when the index
// changed (`catalog.ts`).
export const chordCatalogServed = serveValue(chordCatalog, {
  source: "db",
  reads: {
    tables: [_chordIndexState, _chordIndexRequest],
    reason:
      "the index's two singleton rows: the catalog answers not-ready or is rebuilt when a load moves",
    outsideFeed: {
      tables: [_chordLoopWindows],
      reason:
        "bulk-loaded index windows, read only when the index identity changed; a load's state row announces the change",
    },
  },
  loader: () => loadCatalogState(),
});
