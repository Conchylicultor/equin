import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { LiveColumns } from "@plugins/network/plugins/live/server";
import { ugAlignmentRowsServed } from "./internal/resource";
import { songUgAlignment } from "./internal/tables";

export { songUgAlignment } from "./internal/tables";

export default {
  description:
    "UG sheet alignment, every host's half: owns the sonata_songs_ext_ug_alignment side-table (video, who picked it, the resolver's candidates, status, record), served as a lookup-only live collection, its video id exposed to every list of songs (LiveColumns.Expose). Choosing a video and aligning to it is the machine/ half's.",
  contributions: [
    ...ugAlignmentRowsServed.declare,
    // The video id rides every list of songs (the library's UG cover).
    LiveColumns.Expose(songUgAlignment),
  ],
} satisfies ServerPluginDefinition;
