import { serveCollection } from "@plugins/network/plugins/live/server";
import { ugAlignmentRows } from "../../core";
import { songUgAlignment } from "./tables";

// Server half of the per-song alignment read: the lookup-only collection served
// from the extension entity (`songId` is the `parent_id` PK). The `:rows` point
// routing sends a job's status write to the one song's tuple alone.
export const ugAlignmentRowsServed = serveCollection(ugAlignmentRows, {
  from: songUgAlignment,
});
