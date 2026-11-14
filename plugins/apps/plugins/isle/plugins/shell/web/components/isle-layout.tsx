import { FullPane } from "@plugins/layouts/plugins/full-pane/web";
import { PaneOverlayHost } from "@plugins/layouts/plugins/miller/web";

/**
 * The whole app is one full-surface pane, chromeless (no app shell, no pane
 * header): the world view registers the index pane from its own deferred
 * plugin, so the shell carries nothing heavy. The pane overlay host is mounted
 * so global actions that open panes (the theme customizer) still render here.
 */
export function IsleLayout() {
  return (
    <>
      <FullPane />
      <PaneOverlayHost />
    </>
  );
}
