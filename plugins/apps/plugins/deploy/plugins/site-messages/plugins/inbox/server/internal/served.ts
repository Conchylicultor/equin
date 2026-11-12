import type { LiveDecodedCountQuery } from "@plugins/network/plugins/live/core";
import { serveCollection } from "@plugins/network/plugins/live/server";
import type { ReplicaTx } from "@plugins/database/plugins/table-mirror/plugins/replica/server";
import {
  onSiteMirrorApplied,
  readSiteMirror,
} from "@plugins/apps/plugins/deploy/plugins/site-mirror/plugins/pull/server";
import { SITE_MESSAGES_MIRROR_SET_ID } from "@plugins/apps/plugins/deploy/plugins/site-messages/plugins/intake/core";
import { siteMessagesInbox, type SiteMessageRow } from "../../core";
import {
  deploymentOf,
  messageIdsByDeployment,
  readInboxCount,
  readInboxGroups,
  readInboxRows,
  readInboxWindow,
} from "./reads";

// The inbox's questions (`reads.ts`), answered over this computer's copy of
// one site's `site_messages` — site-mirror's replica of the intake's mirror
// set, read in a snapshot whose search_path is the copy's schema.

/** The copy of one deployment's messages, read with `fn` — loud while no whole copy is in place. */
async function onCopy<T>(
  deploymentId: string,
  fn: (tx: ReplicaTx) => Promise<T>,
): Promise<T> {
  const read = await readSiteMirror(
    deploymentId,
    SITE_MESSAGES_MIRROR_SET_ID,
    fn,
  );
  if (!read.ready) {
    // The inbox mounts its list only once `site-mirror.status` says the copy
    // is in place, so reaching here is a read that raced a reset copy.
    throw new Error(
      `deploy-site-messages.inbox: ${deploymentId}'s copy of its messages is not readable yet (${read.phase})`,
    );
  }
  return read.value;
}

export const siteMessagesInboxServed = serveCollection(siteMessagesInbox, {
  source: "external",
  changes: "notified",
  window: async (q) => {
    const scope = deploymentOf(q.where);
    if (scope.kind === "none") return [];
    return onCopy(scope.id, (tx) => readInboxWindow(tx, scope.id, q));
  },
  rows: async (ids) => {
    const out: SiteMessageRow[] = [];
    for (const [deploymentId, messageIds] of messageIdsByDeployment(ids)) {
      out.push(
        ...(await onCopy(deploymentId, (tx) =>
          readInboxRows(tx, deploymentId, messageIds),
        )),
      );
    }
    return out;
  },
  groups: async (q) => {
    const scope = deploymentOf(q.where);
    if (scope.kind === "none") return [];
    return onCopy(scope.id, (tx) => readInboxGroups(tx, scope.id, q));
  },
  count: async (q: LiveDecodedCountQuery) => {
    const scope = deploymentOf(q.where);
    if (scope.kind === "none") return 0;
    return onCopy(scope.id, (tx) => readInboxCount(tx, scope.id, q.where));
  },
  keyText: { createdAt: (d: Date) => d.toISOString() },
  // A sync that applied a page of any site's copy re-reads every held tuple
  // (each diffed by key); a burst of pages costs one re-read a second.
  whileSubscribed: (notify) =>
    onSiteMirrorApplied({ setId: SITE_MESSAGES_MIRROR_SET_ID }, () => notify()),
  throttleMs: 1000,
});
