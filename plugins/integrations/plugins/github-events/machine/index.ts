import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { machineHandler } from "@plugins/infra/plugins/endpoints/machine";
import { githubDeliveryEndpoint } from "../core";
import { handleDelivery } from "./internal/deliveries";
import { forwarderDaemon } from "./internal/forwarders";
import { startGitHubEvents, stopGitHubEvents } from "./internal/lifecycle";
import { githubEventsStatusServed } from "./internal/status-served";

export { forwarderStatusOf } from "./internal/forwarders";
export { newestRunOf, releaseOf } from "./internal/ingest";
export { githubEventsStatusServed } from "./internal/status-served";

export default {
  description:
    "GitHub events, desktop-only half: on main of the checkout that publishes releases (no upstream), one `gh webhook forward --repo` daemon per watched repo — run as the gh-webhook extension binary itself (a SIGTERM deletes its hook), after deleting any forwarder hook a hard kill left behind, signing with a secret minted per start; POST /api/github-events/deliveries (public: authenticated by the delivery's HMAC, checked over the raw body before anything is parsed) stores workflow_run / workflow_job / release events of watched workflows and releases, files a failed run once per attempt as a github-run-failed report, and re-reads the repo's releases when a run ends; GitHub's ping marks a forwarder connected and triggers one catch-up (each watched workflow's 10 newest runs, the 5 newest releases); the github-events.status live value (off / not-set-up with its fix / per-repo connecting, connected, reconnecting, failed). newestRunOf / releaseOf / forwarderStatusOf answer what a consumer (the publisher's releases row) reads of one tag.",
  httpRoutes: {
    [githubDeliveryEndpoint.route]: machineHandler(
      githubDeliveryEndpoint,
      handleDelivery,
    ),
  },
  contributions: [...githubEventsStatusServed.declare],
  register: [forwarderDaemon],
  onReady: startGitHubEvents,
  onShutdown: stopGitHubEvents,
} satisfies MachinePluginDefinition;
