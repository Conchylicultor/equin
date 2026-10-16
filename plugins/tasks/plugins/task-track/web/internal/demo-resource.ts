import { demoResource } from "@plugins/framework/plugins/browser-server/plugins/demo/web";
import { taskTracks } from "../../shared/resources";

/** Inside a demo scope: Every demo task is on the main track (no side row). */
export const taskTracksDemo = demoResource("task-tracks", (s) => [
  s.serveCollection(taskTracks, {
    source: "external",
    changes: { fixed: { reason: "a demo's neutral answer" } },
    all: () => [],
    rows: () => [],
  }),
]);
