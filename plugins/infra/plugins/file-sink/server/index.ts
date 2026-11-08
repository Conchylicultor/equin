import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { exitFlush } from "./internal/exit-flush";

// The impl lives in `core/` (reachable from every runtime, incl. the CLI check
// runner). This barrel is the plugin's server-runtime presence ONLY — it carries
// no re-exports; import the symbols from `@plugins/infra/plugins/file-sink/core`.
// It arms the exit flush of the async append queue in every backend process.

export default {
  description:
    "Bounded-append file sink primitive: defineFileSink declares an absolute-path sink that rotates at a byte cap (default 128 MB × 3), true by construction because append() IS the rotation. Node-only (no db/jobs) so a CLI process can import it. getFileSinks exposes the registered set; openDynamicSink covers the open-ended browser clientLog family under one declared bound.",
  register: [exitFlush],
} satisfies ServerPluginDefinition;
