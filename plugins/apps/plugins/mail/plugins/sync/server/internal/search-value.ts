import { serveValue, sliceRange } from "@plugins/network/plugins/live/server";
import { mailSearch } from "../../core";
import { searchHits } from "./remote-search";

// The `mail.search` paged value: Gmail's ranked threads for one question, a page
// at a time. Its answer comes from Gmail alone — the held answer
// (`remote-search.ts`) is read from Gmail as far as the page asks, and each
// page is cut from it by rank. The loader also WRITES: the envelopes it sees are
// upserted into the mirror (so the reader's `mail.threads` rows exist), which is
// how older-than-window mail reaches Postgres. The thread rows' flags are live
// through `mail.threads`; this answer is not re-asked within its round (a new
// search is a new round, and asks Gmail again).
export const mailSearchServed = serveValue(mailSearch, {
  source: "external",
  changes: {
    fixed: {
      reason:
        "a third-party answer with no change signal, held for one search round: the reader mints a new round for every search it starts (the tuple carries it), so the held answer — Gmail's ranked threads as first read — never outlives the search that asked; a later page of a dropped round is refused expired, never re-ranked; read/starred flags stay live on the mail.threads rows",
    },
  },
  loader: async (q, range) =>
    sliceRange(
      mailSearch,
      await searchHits(q, range.after?.key[0] ?? null, range.limit),
      range,
    ),
});
