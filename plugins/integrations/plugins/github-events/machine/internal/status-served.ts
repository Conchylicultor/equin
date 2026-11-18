import { serveValue } from "@plugins/network/plugins/live/machine";
import { githubEventsStatus } from "../../core";
import { forwarderStatus, onForwarderStatus } from "./forwarders";

/**
 * `github-events.status`: held in memory by the forwarders, pushed on every
 * change of their state (start, GitHub's ping, a death, a respawn).
 */
export const githubEventsStatusServed = serveValue(githubEventsStatus, {
  source: "external",
  changes: "notified",
  loader: () => Promise.resolve(forwarderStatus()),
});

onForwarderStatus(() => githubEventsStatusServed.notify());
