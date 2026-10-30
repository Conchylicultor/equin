import { db } from "@plugins/database/server";
import { getConfig } from "@plugins/config_v2/server";
import { compositionsConfig } from "@plugins/plugin-meta/plugins/composition/core";
import {
  _deployServers,
  generateServerSshKey,
} from "@plugins/apps/plugins/deploy/plugins/servers/server";
import { deployServerIdKind } from "@plugins/apps/plugins/deploy/plugins/servers/core";
import {
  _deployDeployments,
  _deployRuns,
} from "@plugins/apps/plugins/deploy/plugins/deployments/server";
import {
  deploymentIdKind,
  deployRunIdKind,
} from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { serverHealth } from "@plugins/apps/plugins/deploy/plugins/health/server";
import type { DeployFixture } from "../../core";

/**
 * Writes `fixture` into this instance's Deploy tables, the rows the app's own
 * writers write: a server as `servers`' create handler inserts it, a key as
 * Generate key makes one (`generateServerSshKey`: the private half into the
 * secrets store under the server's id — the fixture's own, so a rewrite
 * replaces the same secret), its last check as `health`'s probe upserts it, each deployment as `deployments`' create handler inserts it (the
 * composition checked against the instance's compositions, as there), and each
 * run as the ledger records a FINISHED one — launched from this namespace's
 * default, never `running`, so nothing reconciles it and no in-flight lock is
 * held. Times are `now - <ago>`. A refusal (an unknown composition) is raised
 * before anything is written.
 */
export async function writeDeployFixture(
  fixture: DeployFixture,
  now: Date = new Date(),
): Promise<void> {
  const known = new Set(
    getConfig(compositionsConfig).manifests.map((m) => m.name),
  );
  for (const server of fixture.servers)
    for (const d of server.deployments)
      if (!known.has(d.compositionId))
        throw new Error(
          `[deploy fixture] "${d.compositionId}" is not a composition of this instance (known: ${[...known].sort().join(", ")})`,
        );
  const ago = (ms: number) => new Date(now.getTime() - ms);

  for (const server of fixture.servers) {
    const serverId = deployServerIdKind.parse(server.id);
    await db.insert(_deployServers).values({
      id: serverId,
      name: server.name,
      host: server.host,
      port: server.port ?? 22,
      sshUser: server.sshUser ?? "root",
      consoleUrl: null,
    });
    const { sshPublicKey } = await generateServerSshKey(serverId);
    if (server.health !== undefined)
      await serverHealth.upsert(
        serverId,
        {
          ok: true,
          checkedAt: ago(server.health.checkedAgoMs),
          failureKind: null,
          failureMessage: null,
          checkedPublicKey: sshPublicKey,
          hostKeyLine: null,
          platform: server.health.platform,
        },
        db,
      );
    for (const deployment of server.deployments) {
      const deploymentId = deploymentIdKind.mint();
      await db.insert(_deployDeployments).values({
        id: deploymentId,
        compositionId: deployment.compositionId,
        serverId,
        hostnames: [...deployment.hostnames],
      });
      for (const run of deployment.runs) {
        const startedAt = ago(run.startedAgoMs);
        await db.insert(_deployRuns).values({
          id: deployRunIdKind.mint(),
          deploymentId,
          serverId,
          compositionId: deployment.compositionId,
          verb: run.verb,
          releaseRunId: null,
          commitSha: run.commitSha,
          status: run.status,
          phaseFailed: run.status === "failed" ? run.phaseFailed : null,
          startedAt,
          finishedAt: new Date(startedAt.getTime() + run.durationMs),
          exitCode: run.status === "failed" ? run.exitCode : 0,
          message: run.status === "failed" ? run.message : null,
          approvalSections: [],
          legRunId: null,
          pid: null,
        });
      }
    }
  }
}
