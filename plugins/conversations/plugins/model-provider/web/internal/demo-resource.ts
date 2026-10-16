import type {
  BrowserServe,
  BrowserServed,
} from "@plugins/framework/plugins/browser-server/core";
import {
  BASELINE_MODELS,
  modelCatalog,
} from "@plugins/conversations/plugins/model-provider/core";

/**
 * The model catalog inside a demo scope (`Demo.Resource`): the baseline — the
 * catalog of a machine that never probed its Claude CLI — never this
 * machine's discovered one. Module-level, so the serve function is stable.
 */
export function serveDemoCatalog(s: BrowserServe): readonly BrowserServed[] {
  return [
    s.serveValue(modelCatalog, {
      source: "external",
      changes: { fixed: { reason: "the baseline catalog is code" } },
      loader: () => BASELINE_MODELS,
    }),
  ];
}
