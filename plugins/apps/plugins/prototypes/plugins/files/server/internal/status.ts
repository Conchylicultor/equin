import { statSync } from "node:fs";
import { serveValue } from "@plugins/network/plugins/live/server";
import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { originOf } from "@plugins/infra/plugins/request-origin/core";
import { defineAgentWriteLedger } from "@plugins/infra/plugins/request-origin/plugins/agent-write-ledger/server";
import {
  protoIdKind,
  prototypeStatuses,
  setPrototypeStatus,
  type PrototypeStatusChange,
} from "../../core";
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import { openStatusStore, type StatusStore } from "../../shared/status";

// The server's face of the status store (`shared/status.ts`): the statuses
// resource, the one write endpoint, and the agent-write ledger that puts an
// automated session's change back. Mirrors `picks.ts`.
//
// The writer notifies its own subscribers the moment it writes. Every OTHER
// backend learns through the one watcher over the tree (`_status/<id>.json` →
// `status-recorded`, `tree-path.ts`) — the store is host-global.

/** The store over the data dir, resolved per call (the data root is env-overridable). */
function store(): StatusStore {
  return openStatusStore(prototypesDir.path);
}

/** A prototype folder exists under this id. */
function prototypeExists(name: string): boolean {
  if (!protoIdKind.is(name)) return false;
  const stat = statSync(prototypesDir.file(name), { throwIfNoEntry: false });
  return stat?.isDirectory() ?? false;
}

/**
 * `prototypes.statuses` — every recorded status, keyed by prototype id. Push;
 * notified by the PUT below on this backend and by the watcher on every
 * backend. A malformed file throws (`record-store.ts`).
 */
export const prototypeStatusesServed = serveValue(prototypeStatuses, {
  source: "external",
  changes: "notified",
  loader: async () => store().readAll(),
});

/**
 * What an automated browser session did to a prototype's status, so the e2e
 * harness can put it back at the end of its run: an E2E that ticks Done must
 * not leave the user's gallery changed. A no-op for every other writer.
 */
const statusLedger = defineAgentWriteLedger<"status">({
  id: "prototype-status",
  label: "Prototype status",
  restore: async (entry) => {
    const s = store();
    // The ledger holds absolute paths; the store derives them from the id. If
    // the two disagree the data root moved under the ledger, and writing
    // either one would be a guess.
    if (entry.paths.status !== s.fileOf(entry.key)) {
      throw new Error(
        `prototype-status ledger: ${entry.key} was recorded at ${entry.paths.status}, but its status file is ${s.fileOf(entry.key)}`,
      );
    }
    await s.restore(entry.key, entry.before.status);
    prototypeStatusesServed.notify();
  },
});

/** The ledger's words for one change (`mark done, pin`). */
function describeChange(change: PrototypeStatusChange): string {
  const words: string[] = [];
  if (change.done !== undefined)
    words.push(change.done ? "mark done" : "mark not done");
  if (change.pinned !== undefined) words.push(change.pinned ? "pin" : "unpin");
  return words.join(", ");
}

/**
 * `PUT /api/prototypes/:name/status` — apply one change (`{ done?, pinned? }`). 404 for
 * an unknown prototype. Snapshotted for the agent-write ledger inside the
 * store's lock, around the one write.
 */
export const handleSetStatus = implement(
  setPrototypeStatus,
  async ({ params, body, req }) => {
    const { name } = params;
    if (!prototypeExists(name)) {
      throw new HttpError(404, `no such prototype: ${name}`);
    }
    const writer = originOf(req);
    const s = store();
    await s.write(name, body, {
      beforeWrite: () =>
        statusLedger.record(
          writer,
          name,
          { status: s.fileOf(name) },
          describeChange(body),
        ),
      afterWrite: () => statusLedger.noteComplete(writer, name),
    });
    prototypeStatusesServed.notify();
  },
);
