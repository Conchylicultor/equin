import { Pane, defineRoute } from "@plugins/primitives/plugins/pane/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { OpDetailBody } from "./components/op-detail";

export const opDetailPane = Pane.define({
  route: defineRoute({
    id: "debug-profiling-op-detail",
    segment: "op-profile/:opId",
  }),
  app: debugApp,
  title: "Op",
  component: OpDetailBody,
  useResolve: false,
});
