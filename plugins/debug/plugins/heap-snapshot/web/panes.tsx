import type { ReactElement } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { HeapPanel } from "./components/heap-panel";

export const heapSnapshotPane = Pane.define({
  title: "Heap",
  route: defineRoute({
    id: "debug-heap-snapshot",
    segment: "heap",
  }),
  app: debugApp,
  component: HeapSnapshotBody,
});

function HeapSnapshotBody(): ReactElement {
  return (
    <PaneChrome pane={heapSnapshotPane} inset="document">
      <HeapPanel />
    </PaneChrome>
  );
}
