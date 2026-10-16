import { demoResource } from "@plugins/framework/plugins/browser-server/plugins/demo/web";
import { editedFiles } from "../../core";

/** Inside a demo scope: No demo conversation has edited files on disk (there is no disk). */
export const editedFilesDemo = demoResource("edited-files", (s) => [
  s.serveValue(editedFiles, {
    source: "external",
    changes: { fixed: { reason: "a demo's neutral answer" } },
    loader: () => ({ resolved: true as const, value: [] }),
  }),
]);
