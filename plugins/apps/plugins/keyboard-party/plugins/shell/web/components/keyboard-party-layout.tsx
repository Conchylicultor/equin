import { PaneOverlayHost } from "@plugins/layouts/plugins/miller/web";
import { PartyStage } from "@plugins/apps/plugins/keyboard-party/plugins/party/web";

/**
 * The whole app is one full-surface stage. Bespoke full-surface layout: mount
 * the pane overlay so global actions that open panes (e.g. the theme
 * customizer) still render here.
 */
export function KeyboardPartyLayout() {
  return (
    <>
      <PartyStage />
      <PaneOverlayHost />
    </>
  );
}
