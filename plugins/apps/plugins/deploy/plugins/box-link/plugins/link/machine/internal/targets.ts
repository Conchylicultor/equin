import { createHash } from "node:crypto";
import { asc } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type { SshTarget } from "@plugins/infra/plugins/ssh/server";
import { _deployDeployments } from "@plugins/apps/plugins/deploy/plugins/deployments/server";
import { resolveServerSshTarget } from "@plugins/apps/plugins/deploy/plugins/health/server";
import { standInServerIds } from "@plugins/apps/plugins/deploy/plugins/host-query/server";

/** One deployment a link serves: its id and the box gateway's loopback port. */
export interface LinkDeployment {
  deploymentId: string;
  loopbackPort: number;
}

/**
 * How the links of one server's deployments are reached:
 *
 * - `stand-in` — a demo's server whose box is THIS instance (host-query's
 *   stand-ins): no tunnel, the stream comes through this instance's gateway;
 * - `ssh` — a real box: one tunnel, one forward per deployment. `signature`
 *   names everything the tunnel's argv is built from (address, user, key,
 *   pinned host key, ports): a changed one restarts the tunnel;
 * - `blocked` — a real box the link cannot dial yet: no SSH key, or a host
 *   key never pinned by a connection check.
 */
export type LinkTarget =
  | { kind: "stand-in"; serverId: string; deployments: LinkDeployment[] }
  | {
      kind: "ssh";
      serverId: string;
      deployments: LinkDeployment[];
      target: SshTarget;
      signature: string;
    }
  | {
      kind: "blocked";
      serverId: string;
      deployments: LinkDeployment[];
      reason: "no-ssh-key" | "unverified";
    };

function signatureOf(target: SshTarget, deployments: LinkDeployment[]): string {
  const hostKey =
    target.hostKey.mode === "pinned" ? target.hostKey.knownHostsLine : "learn";
  return createHash("sha256")
    .update(
      JSON.stringify([
        target.host,
        target.port,
        target.user,
        target.privateKey,
        hostKey,
        deployments.map((d) => [d.deploymentId, d.loopbackPort]),
      ]),
    )
    .digest("hex");
}

/**
 * What this instance links, per server: every stand-in box, and — only when
 * `realBoxes` (main: one instance per user holds the real links) — every
 * other server, reached over SSH with the same address, key and pinned host
 * key rules as every other reader of the box (`require-pinned`).
 */
export async function readLinkTargets(opts: {
  realBoxes: boolean;
}): Promise<LinkTarget[]> {
  const rows = await db
    .select({
      deploymentId: _deployDeployments.id,
      serverId: _deployDeployments.serverId,
      loopbackPort: _deployDeployments.loopbackPort,
    })
    .from(_deployDeployments)
    .orderBy(asc(_deployDeployments.id));
  const byServer = new Map<string, LinkDeployment[]>();
  for (const r of rows) {
    const list = byServer.get(r.serverId) ?? [];
    list.push({ deploymentId: r.deploymentId, loopbackPort: r.loopbackPort });
    byServer.set(r.serverId, list);
  }
  const standIns = await standInServerIds();
  const targets: LinkTarget[] = [];
  for (const [serverId, deployments] of byServer) {
    if (standIns.has(serverId)) {
      targets.push({ kind: "stand-in", serverId, deployments });
      continue;
    }
    if (!opts.realBoxes) continue;
    const ssh = await resolveServerSshTarget(serverId, "require-pinned");
    switch (ssh.kind) {
      case "not-found":
        // Deleted since the read above (the deployments cascade with it).
        break;
      case "no-key":
        targets.push({
          kind: "blocked",
          serverId,
          deployments,
          reason: "no-ssh-key",
        });
        break;
      case "unpinned":
        targets.push({
          kind: "blocked",
          serverId,
          deployments,
          reason: "unverified",
        });
        break;
      case "ready":
        targets.push({
          kind: "ssh",
          serverId,
          deployments,
          target: ssh.target,
          signature: signatureOf(ssh.target, deployments),
        });
        break;
    }
  }
  return targets;
}
