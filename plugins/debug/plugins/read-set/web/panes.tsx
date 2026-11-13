import type { ReactElement } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { ReadSetView } from "./components/read-set-view";

export const readSetPane = Pane.define({
  title: "Read-set",
  route: defineRoute({
    id: "debug-read-set",
    segment: "read-set",
  }),
  app: debugApp,
  component: ReadSetBody,
});

function ReadSetBody(): ReactElement {
  return (
    <PaneChrome pane={readSetPane} inset="document">
      <ReadSetView />
    </PaneChrome>
  );
}
