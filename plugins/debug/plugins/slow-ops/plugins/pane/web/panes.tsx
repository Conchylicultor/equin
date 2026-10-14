import { Pane, PaneChrome } from "@plugins/primitives/plugins/pane/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { slowOpDetailRoute } from "@plugins/debug/plugins/slow-ops/core";
import { SlowOpDetail } from "./components/slow-op-detail";

// Detail pane (/debug/traces/op/:id): one slow op — its callers (paged, live),
// waits, variants, measures and recent samples. Opened from the Aggregates tab.
export const slowOpDetailPane = Pane.define({
  title: "Slow op",
  route: slowOpDetailRoute,
  app: debugApp,
  component: SlowOpDetailBody,
  width: 640,
  // No route guard — the detail self-fetches by id and renders a graceful
  // not-found (the trace detail precedent).
  useResolve: false,
});

function SlowOpDetailBody() {
  const { id } = slowOpDetailPane.useParams();
  return (
    <PaneChrome pane={slowOpDetailPane}>
      <SlowOpDetail id={id} />
    </PaneChrome>
  );
}
