import { statSync } from "node:fs";
import { serveValue } from "@plugins/network/plugins/live/server";
import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { originOf } from "@plugins/infra/plugins/request-origin/core";
import { defineAgentWriteLedger } from "@plugins/infra/plugins/request-origin/plugins/agent-write-ledger/server";
import {
  protoIdKind,
  prototypePicks,
  setPrototypePicks,
  type PicksChange,
} from "../../core";
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import { openPicksStore, type PicksStore } from "../../shared/picks";

// The server's face of the option-picks store (`shared/picks.ts`): the
// per-prototype picks resource, the one write endpoint, and the agent-write
// ledger that puts an automated session's picks back.
//
// The writer notifies its own subscribers the moment it writes. Every OTHER
// backend learns through the one watcher over the tree (`_picks/<id>.json` →
// `picks-recorded`, `tree-path.ts`) — the store is host-global, so a pick made
// on main has to reach a worktree deploy's open tab, and the reverse.

/** The store over the data dir, resolved per call (the data root is env-overridable). */
function store(): PicksStore {
  return openPicksStore(prototypesDir.path);
}

/** A prototype folder exists under this id. */
function prototypeExists(name: string): boolean {
  if (!protoIdKind.is(name)) return false;
  const stat = statSync(prototypesDir.file(name), { throwIfNoEntry: false });
  return stat?.isDirectory() ?? false;
}

/**
 * `prototypes.picks` — one prototype's stored picks, served from the file
 * store. Pushed per `name`; notified by the PUT below on this backend and by
 * the watcher (`watcher.ts`) on every backend.
 *
 * Nothing picked is `{}`, a legitimate answer. A name that is not a minted id,
 * or names no folder, throws — the detail pane reads the picks only for a
 * prototype the list vouches for, so there is no empty answer to give. A
 * malformed file throws too (`shared/picks.ts`): an unreadable record is not
 * "nothing picked".
 */
export const prototypePicksServed = serveValue(prototypePicks, {
  source: "external",
  changes: "notified",
  loader: async ({ name }) => {
    if (!prototypeExists(name)) {
      throw new Error(`prototypes.picks: no such prototype: ${name}`);
    }
    return store().read(name);
  },
});

/**
 * What an automated browser session did to a prototype's picks, so the e2e
 * harness can put it back at the end of its run: an E2E that clicks the picker
 * must not leave the user looking at another variant. A no-op for every other
 * writer. Keyed by the prototype id; the one file is the picks file.
 */
const picksLedger = defineAgentWriteLedger<"picks">({
  id: "prototype-picks",
  label: "Prototype option picks",
  restore: async (entry) => {
    const s = store();
    // The ledger holds absolute paths; the store derives them from the id. If
    // the two disagree the data root moved under the ledger, and writing
    // either one would be a guess.
    if (entry.paths.picks !== s.fileOf(entry.key)) {
      throw new Error(
        `prototype-picks ledger: ${entry.key} was recorded at ${entry.paths.picks}, but its picks file is ${s.fileOf(entry.key)}`,
      );
    }
    await s.restore(entry.key, entry.before.picks);
    prototypePicksServed.notify({ name: entry.key });
  },
});

/** How the ledger names one change. */
function describeChange(change: PicksChange): string {
  return change.kind === "reset"
    ? "reset"
    : `set ${change.option}=${change.value}`;
}

/**
 * `PUT /api/prototypes/:name/picks` — apply one change (`set` one option, or
 * `reset` them all). 404 for an unknown prototype. Snapshotted for the
 * agent-write ledger inside the store's lock, around the one write, so its
 * "before" and "after" are exactly what this write replaced and left.
 */
export const handleSetPicks = implement(
  setPrototypePicks,
  async ({ params, body, req }) => {
    const { name } = params;
    if (!prototypeExists(name)) {
      throw new HttpError(404, `no such prototype: ${name}`);
    }
    const writer = originOf(req);
    const s = store();
    await s.write(name, body, {
      beforeWrite: () =>
        picksLedger.record(
          writer,
          name,
          { picks: s.fileOf(name) },
          describeChange(body),
        ),
      afterWrite: () => picksLedger.noteComplete(writer, name),
    });
    prototypePicksServed.notify({ name });
  },
);
