import { DocumentHead } from "@plugins/shell/plugins/document-head/server";
import { demoApp, demoScenario } from "../../core";

/**
 * The /demo page's head script: starts the demo's host before the app boots,
 * so the worker's boot runs alongside the page's own bundle. An async module
 * importing only the host module and `demo/prestart` — nothing of the app, so
 * it runs as soon as those few modules load. The scenario is the one the page
 * renders (`demoScenario`), spelled from it here.
 */
const PRESTART_SCRIPT =
  `<script type="module" async>` +
  `import { prestartDemoHost } from "@plugins/framework/plugins/browser-server/plugins/demo/plugins/prestart/web";` +
  `import * as host from ${JSON.stringify(demoScenario.host.module)};` +
  `prestartDemoHost(${JSON.stringify(demoScenario.id)}, host);` +
  `</script>`;

export const prestartHead = DocumentHead.Fragment({
  id: "demo-prestart",
  render: () => Promise.resolve({ [demoApp.basePath]: PRESTART_SCRIPT }),
  // A constant: nothing changes it while the backend runs.
  subscribe: () => () => undefined,
});
