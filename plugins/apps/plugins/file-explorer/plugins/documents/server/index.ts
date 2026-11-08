import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { documentsFiles } from "./internal/roots";
// A demo's seed (or a test) writes the user's Documents through this.
export { writeDocumentsFixture, type DocumentsFixture } from "./internal/write";

export default {
  description:
    "Documents, portable half: Files' data dir (apps/file-explorer) as the documentsFiles file root — watched, and browsable read-only in App data as \"Documents\" on every host (the computer's disk on the desktop, memory in a browser host) — and writeDocumentsFixture, which writes a fixture's files through the root's own writes for a demo's seed or a test.",
} satisfies ServerPluginDefinition;
