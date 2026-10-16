import { demoResource } from "@plugins/framework/plugins/browser-server/plugins/demo/web";
import { machineSleep } from "../../core";

/** Inside a demo scope: A demo machine never slept. */
export const machineSleepDemo = demoResource("machine-sleep", (s) => [
  s.serveValue(machineSleep, {
    source: "external",
    changes: { fixed: { reason: "a demo's neutral answer" } },
    loader: () => ({ boot: "demo", asleepMs: 0, wakeAtMs: null }),
  }),
]);
