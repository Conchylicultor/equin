import { BlockLifecycle } from "@plugins/page/plugins/editor/server";
import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { blockDocsServed } from "./internal/resource";
import { copyBlockDocsHook } from "./internal/copy-hook";
import { handleBlockDocInit, handleBlockDocUpdate } from "./internal/routes";
import { blockDocInit, blockDocUpdate } from "../core";

export { _pageBlockDocs } from "./internal/tables";
export { blockDocsServed } from "./internal/resource";
// The doc store, for a server-side writer that must edit a block's text with no
// mounted editor (today `page/block-text-write`). Bytes in, bytes out — exporting
// them costs this plugin nothing of its content-agnostic charter, which a
// runs-aware or Lexical-aware export would breach.
export {
  loadBlockDocs,
  initBlockDoc,
  mergeBlockDocUpdate,
} from "./internal/doc-store";

export default {
  portable: true,
  description:
    "Per-block content-CRDT server (content-agnostic): the page_block_docs state store, the per-block lookup-only live collection (page-block-doc:rows), the first-writer-wins doc-init seed, and the doc-update Yjs merge endpoint.",
  contributions: [
    ...blockDocsServed.declare,
    BlockLifecycle.OnCopy(copyBlockDocsHook),
  ],
  httpRoutes: {
    [blockDocInit.route]: handleBlockDocInit,
    [blockDocUpdate.route]: handleBlockDocUpdate,
  },
} satisfies ServerPluginDefinition;
