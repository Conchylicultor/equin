import { serveCollection } from "@plugins/network/plugins/live/server";
import { songUgRows } from "../../shared/resources";
import { songUltimateGuitar } from "./tables";

// Server half of the per-song UG read: the lookup-only collection served from
// the extension entity (`songId` is the `parent_id` PK).
export const songUgRowsServed = serveCollection(songUgRows, {
  from: songUltimateGuitar,
});
