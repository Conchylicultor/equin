import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { IconsPage } from "./components/icons-page";

export const iconsPane = Pane.define({
  title: "Icons",
  route: defineRoute({
    id: "debug-icons",
    segment: "icons",
  }),
  app: debugApp,
  component: IconsBody,
});

function IconsBody() {
  return (
    <PaneChrome pane={iconsPane}>
      <IconsPage />
    </PaneChrome>
  );
}
