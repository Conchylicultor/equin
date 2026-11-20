import { db } from "@plugins/database/server";
import type { BoxLink } from "@plugins/apps/plugins/deploy/plugins/box-link/core";
import { deploymentBoxLink } from "./tables";

/** What a link keeps across a restart of this computer (its state starts over). */
export type KeptBoxLink = Pick<
  BoxLink,
  "lastHeardAt" | "lastBeat" | "lastError" | "hello"
>;

/** Every deployment's link as last persisted, for the link manager's boot. */
export async function readKeptBoxLinks(): Promise<Map<string, KeptBoxLink>> {
  const rows = await db.select().from(deploymentBoxLink.table);
  return new Map(
    rows.map((r) => [
      r.deploymentId,
      {
        lastHeardAt: r.lastHeardAt === null ? null : r.lastHeardAt.getTime(),
        lastBeat: r.lastBeat,
        lastError: r.lastError,
        hello: r.hello,
      },
    ]),
  );
}

/** Write a link's record — called on a state change only, never per beat. */
export async function writeBoxLinkState(link: BoxLink): Promise<void> {
  await deploymentBoxLink.upsert(link.deploymentId, {
    state: link.state,
    since: new Date(link.since),
    lastHeardAt: link.lastHeardAt === null ? null : new Date(link.lastHeardAt),
    lastBeat: link.lastBeat,
    lastError: link.lastError,
    hello: link.hello,
  });
}
