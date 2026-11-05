import { resolve } from "node:path";
import { z } from "zod";
import { callEndpoint } from "@plugins/infra/plugins/endpoints/server";
import { EndpointError } from "@plugins/infra/plugins/endpoints/core";
import { adaptiveTimeoutMs } from "@plugins/framework/plugins/cli/plugins/bootstrap/cli";
import type {
  adoptCentralDeploy,
  adoptDeploy,
  AdoptVerdict,
} from "@plugins/build/plugins/restart-skip/core";

/**
 * Ask a running backend (or central) to adopt this deploy instead of being
 * restarted for it (`build/restart-skip`). The process judges — only it knows
 * what it loaded; this side only says what the spec it is about to be
 * restarted under spawns. Fails toward restart: no command to compare (the
 * gateway's default Bun), no commit to pin, nothing answering, or a process
 * too old to know the route — each is `restart` with its reason.
 */
export async function askAdoption(opts: {
  endpoint: typeof adoptDeploy | typeof adoptCentralDeploy;
  /** Where the process is reached: its namespace's URL, or the gateway for central. */
  origin: string;
  /** The spec's `server` dir, which the command's entry is relative to. */
  server: string;
  /** The spec's `command`, as just written. */
  command: string[] | undefined;
  commit: string | null;
}): Promise<AdoptVerdict> {
  const { command, commit } = opts;
  if (command === undefined) {
    return {
      kind: "restart",
      reason: "the spec runs the gateway's default Bun",
    };
  }
  if (commit === null) {
    return { kind: "restart", reason: "this build has no commit to pin" };
  }
  const [bin, entry] = command;
  if (bin === undefined || entry === undefined) {
    return {
      kind: "restart",
      reason: `the spec's command is not [bun, entry]: ${JSON.stringify(command)}`,
    };
  }
  try {
    return await callEndpoint(
      opts.endpoint,
      {},
      {
        origin: opts.origin,
        body: { bin, entry: resolve(opts.server, entry), commit },
        signal: AbortSignal.timeout(adaptiveTimeoutMs(30_000, 120_000)),
      },
    );
  } catch (err) {
    // Nothing serving (TypeError), no answer in time (DOMException), a
    // process that predates the route or is still booting (a non-2xx), or a
    // reply this checkout's contract rejects (ZodError): none vouches for the
    // running code. Anything else is unexpected — rethrow.
    if (
      !(err instanceof TypeError) &&
      !(err instanceof DOMException) &&
      !(err instanceof EndpointError) &&
      !(err instanceof z.ZodError)
    )
      throw err;
    return {
      kind: "restart",
      reason: `no answer to the adopt request (${err instanceof EndpointError ? `HTTP ${err.status}` : err.message})`,
    };
  }
}
