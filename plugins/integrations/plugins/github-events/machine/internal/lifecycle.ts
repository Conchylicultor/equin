import { resolveUpstreamRemote } from "@plugins/infra/plugins/git/plugins/remotes/core";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { watchedRepos } from "../../server";
import {
  markForwardersOff,
  markNotSetUp,
  startForwarders,
  stopForwarders,
} from "./forwarders";
import { resolveGhTools } from "./gh";

/** The gh binary the running forwarders use; `null` while none runs. */
let ghBin: string | null = null;

/** The gh binary the running forwarders use, for the API reads deliveries trigger. */
export function runningGh(): string {
  if (ghBin === null)
    throw new Error(
      "[github-events] no forwarder runs on this backend: a delivery cannot have been verified",
    );
  return ghBin;
}

/**
 * Start the forwarders when this backend is main's on the checkout that
 * publishes releases (no upstream: it IS the canonical repo) — on every
 * other backend and checkout nothing runs and the status is `off`.
 */
export async function startGitHubEvents(): Promise<void> {
  if (!isMain()) return markForwardersOff();
  const upstream = await resolveUpstreamRemote(await getWorktreeRoot());
  if (upstream.kind !== "none" || upstream.reason !== "is-publisher")
    return markForwardersOff();
  const tools = await resolveGhTools();
  if (tools.kind === "not-set-up") return markNotSetUp(tools.reason, tools.fix);
  ghBin = tools.tools.gh;
  startForwarders(tools.tools, watchedRepos());
}

export async function stopGitHubEvents(): Promise<void> {
  await stopForwarders();
  ghBin = null;
}
