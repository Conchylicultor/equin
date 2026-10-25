import { eq } from "drizzle-orm";
import type { z } from "zod";
import { db } from "@plugins/database/server";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { sshRun } from "@plugins/infra/plugins/ssh/server";
import { _deployDeployments } from "@plugins/apps/plugins/deploy/plugins/deployments/server";
import { deploymentIdKind } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { resolveServerSshTarget } from "@plugins/apps/plugins/deploy/plugins/health/server";
import {
  SSH_TIMEOUT_MS,
  queryOverSsh,
  type DeploymentTarget,
  type HostQueryAnswer,
} from "./query-over-ssh";

/** SSH sessions to boxes at once, across every reader of every host-only route. */
const SSH_SESSIONS = 2;
const sshSessions = createSemaphore(SSH_SESSIONS);

async function resolveDeployment(
  deploymentId: string,
): Promise<DeploymentTarget> {
  const [deployment] = await db
    .select()
    .from(_deployDeployments)
    .where(eq(_deployDeployments.id, deploymentIdKind.key(deploymentId)));
  if (!deployment) return { kind: "not-found" };

  // A reader, not the connection check: it never learns a host key it would
  // not persist, so an unverified server is refused rather than trusted.
  const ssh = await resolveServerSshTarget(
    deployment.serverId,
    "require-pinned",
    { timeoutMs: SSH_TIMEOUT_MS },
  );
  switch (ssh.kind) {
    case "not-found":
      // FK cascade deletes the deployment with its server, so this is a race.
      return { kind: "not-found" };
    case "no-key":
      return { kind: "no-ssh-key" };
    case "unpinned":
      return { kind: "unverified" };
    case "ready":
      return {
        kind: "ready",
        target: ssh.target,
        loopbackPort: deployment.loopbackPort,
      };
  }
}

/**
 * Ask a deployment's box one host-only route and parse its answer with
 * `schema`. Resolves the deployment's server and pinned SSH target (an
 * unverified server is refused, never trusted), then curls
 * `http://127.0.0.1:<loopbackPort><path>` on the box — through the install's
 * gateway, the one hop `hostOnly` accepts. At most two sessions run at once.
 *
 * `path` must be under `/api/host-only/` and need no shell quoting (throws
 * otherwise). The answer is discriminated, never an empty value: the parsed
 * answer, a {@link HostQueryFailure}, or `not-found` for a deployment that no
 * longer exists.
 *
 * Reads Postgres (deployment row, server, pinned host key, key secret) on
 * every call: the private key and host key may only be read here, at SSH time.
 * A live value serving this is therefore a `snapshot` external — the remote
 * answer has no change signal on this side.
 */
export function hostOnlyQueryOverSsh<T>(
  deploymentId: string,
  path: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<HostQueryAnswer<T>> {
  return sshSessions.run(() =>
    queryOverSsh({ resolveDeployment, sshRun }, deploymentId, path, schema),
  );
}
