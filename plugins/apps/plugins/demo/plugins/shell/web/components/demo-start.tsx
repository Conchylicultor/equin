import { useEffect, type ReactNode } from "react";
import { Pane, useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { demoApp, demoStartRoute } from "../../core";
import { useStartLocation } from "../internal/location";
import { demoAtPane } from "./demo-at";

/** `/demo`: the demo at its start — settles on {@link demoAtPane} at once. */
export const demoStartPane = Pane.define({
  title: "Demo",
  route: demoStartRoute,
  app: demoApp,
  appIndex: true,
  component: DemoStart,
});

/**
 * The demo starts on its composition's home app (the app gallery), written
 * into the URL before the demo mounts — so the one pane that shows the demo
 * ({@link demoAtPane}) is the one it stays in.
 */
function DemoStart(): ReactNode {
  const url = useStartLocation();
  const openPane = useOpenPane();
  useEffect(() => {
    if (url !== undefined)
      openPane(demoAtPane, { url }, { mode: "root", replace: true });
  }, [openPane, url]);
  return <Loading />;
}
