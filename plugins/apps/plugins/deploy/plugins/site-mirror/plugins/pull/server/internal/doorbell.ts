import { and, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { tableMirrorReplicas } from "@plugins/database/plugins/table-mirror/plugins/replica/server";
import { deploymentIdKind } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import {
  onBoxHello,
  onBoxSignal,
} from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/link/server";
import {
  MIRROR_BOX_SIGNAL_SOURCE,
  MirrorBoxSignalSchema,
} from "@plugins/apps/plugins/deploy/plugins/site-mirror/core";
import { requestPull } from "./jobs";
import { siteMirrorSinkOf } from "./sink";
import { siteMirrorReplicas } from "./tables";

/**
 * The least time between two pulls of one replica the doorbell asks for: a
 * busy site rings every couple of seconds (the box's own 2 s throttle), and
 * a pull is an SSH round trip.
 */
export const DOORBELL_SPACING_MS = 5_000;

/**
 * When a pull the doorbell asks for runs: now, unless the replica's last
 * attempt is closer than `spacingMs` — then at `lastAttemptAt + spacingMs`.
 * A ring storm therefore costs one pull per spacing, and the last ring of a
 * burst is never lost (its pull runs at the deadline and reads everything).
 */
export function doorbellRunAt(
  now: number,
  lastAttemptAt: number | null,
  spacingMs: number,
): number {
  return lastAttemptAt === null
    ? now
    : Math.max(now, lastAttemptAt + spacingMs);
}

/**
 * Ask for a spaced pull of each replica this computer keeps of the
 * deployment — one set's, or (`setId` null, a reconnect's catch-up) every
 * one. A set nobody asked for has no replica and is not pulled. A set read
 * through a sink keeps its pace: spaced by its own `minIntervalMs`.
 */
async function ring(deploymentId: string, setId: string | null): Promise<void> {
  const key = deploymentIdKind.key(deploymentId);
  const rows = await db
    .select({
      setId: siteMirrorReplicas.setId,
      lastAttemptAt: tableMirrorReplicas.lastAttemptAt,
    })
    .from(siteMirrorReplicas)
    .innerJoin(
      tableMirrorReplicas,
      eq(tableMirrorReplicas.id, siteMirrorReplicas.replicaId),
    )
    .where(
      setId === null
        ? eq(siteMirrorReplicas.deploymentId, key)
        : and(
            eq(siteMirrorReplicas.deploymentId, key),
            eq(siteMirrorReplicas.setId, setId),
          ),
    );
  const now = Date.now();
  for (const r of rows) {
    const spacing =
      siteMirrorSinkOf(r.setId)?.pace.minIntervalMs ?? DOORBELL_SPACING_MS;
    const runAt = doorbellRunAt(
      now,
      r.lastAttemptAt?.getTime() ?? null,
      spacing,
    );
    await requestPull(deploymentId, r.setId, { runAt: new Date(runAt) });
  }
}

let stops: (() => void)[] = [];

/**
 * The box link's doorbell: a box's `table-mirror` signal pulls the set it
 * names; a box's hello (every reconnect) pulls every replica of that
 * deployment — the catch-up for signals missed while the link was down.
 * Until {@link stopDoorbell}.
 */
export function startDoorbell(): void {
  stopDoorbell();
  const stopSignal = onBoxSignal(
    MIRROR_BOX_SIGNAL_SOURCE,
    (deploymentId, payload) => {
      const { setId } = MirrorBoxSignalSchema.parse(payload);
      void runTracked("site-mirror: doorbell pull", () =>
        ring(deploymentId, setId),
      );
    },
  );
  const stopHello = onBoxHello((deploymentId) => {
    void runTracked("site-mirror: catch-up pull on a box hello", () =>
      ring(deploymentId, null),
    );
  });
  stops = [stopSignal, stopHello];
}

/** Stop answering the doorbell. */
export function stopDoorbell(): void {
  for (const stop of stops) stop();
  stops = [];
}
