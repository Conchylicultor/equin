import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { sshRun } from "@plugins/infra/plugins/ssh/server";
import { _deployDeployments } from "@plugins/apps/plugins/deploy/plugins/deployments/server";
import { deploymentIdKind } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { resolveServerSshTarget } from "@plugins/apps/plugins/deploy/plugins/health/server";
import { deploymentAnalytics } from "../../core";
import {
  SSH_TIMEOUT_MS,
  queryAnalyticsOverSsh,
  type DeploymentTarget,
} from "./query-over-ssh";

/** SSH sessions to boxes at once, across every reader (the old route's cap). */
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
    {
      timeoutMs: SSH_TIMEOUT_MS,
    },
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

// A snapshot, not `db` and not "notified": the answer is the remote site's
// report, which moves with every visit and has no change signal on this side.
// Under `db` it would be labelled fresh while only an unrelated write to the
// deployment or server row re-asked the box; "notified" would claim a notifier
// nobody has. The loader also resolves the deployment's SSH target from
// Postgres (row, server, pinned host key, key secret) — the private key and
// the pinned host key may only be read here, at SSH time, so it cannot be
// resolved outside the loader. That part is re-read on every measure with the
// report, so it is never staler than the report the snapshot already says is
// re-measured only on ask.
//
// That Postgres read is UNDECLARED: it reaches the loader as an injected
// dependency (`{ resolveDeployment, sshRun }`), which `no-db-backed-notify`'s
// lexical scan cannot follow, so no exemption can record it (the check reports
// one as dead) and the runtime's D5 guard skips snapshot externals. Only
// `snapshot` keeps it honest — never copy this loader into a `fixed` value.
// The check gap: task-1792607417-zpzsb4.
export const deploymentAnalyticsServed = serveValue(deploymentAnalytics, {
  source: "external",
  changes: {
    snapshot: {
      reason:
        "the deployed site's report, read over SSH from its box: it changes with every visit and has no change signal here",
    },
  },
  loader: async ({ deploymentId, query }) => {
    const result = await sshSessions.run(() =>
      queryAnalyticsOverSsh({ resolveDeployment, sshRun }, deploymentId, query),
    );
    if (result.kind === "not-found") {
      throw deploymentAnalytics.refuse(
        "missing",
        "This deployment no longer exists.",
      );
    }
    return result;
  },
});
