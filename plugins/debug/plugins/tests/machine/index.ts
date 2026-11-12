import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { runTestsNow } from "../core";
import {
  checkoutDigestsJob,
  digestGenerationServed,
  digestsOnMainAdvance,
} from "./internal/checkout-digests";
import {
  startIngest,
  stopIngest,
  testRunRecordsWatcher,
} from "./internal/ingest";
import { handleRunNow, runNowJob } from "./internal/run-now";

export { requestCheckoutDigests } from "./internal/checkout-digests";
export { ingestRunRecordsNow } from "./internal/ingest";

export default {
  description:
    "Debug → Tests, desktop-only half: ingests the host-global test-run records into this backend's tables (a watch on the records dir, one pass at boot), keeps the checkout's test digests current while the page is open (the tests.checkout-digests supervised job, asked on subscribe and on every advance of main, behind the tests.digest-generation value), and runs Run now's `./equin test` as the tests.run-now supervised job.",
  httpRoutes: {
    [runTestsNow.route]: handleRunNow,
  },
  register: [
    testRunRecordsWatcher,
    checkoutDigestsJob,
    runNowJob,
    digestsOnMainAdvance,
  ],
  contributions: [...digestGenerationServed.declare],
  onReady: startIngest,
  onShutdown: stopIngest,
} satisfies MachinePluginDefinition;
