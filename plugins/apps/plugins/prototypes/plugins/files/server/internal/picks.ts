import { prototypesFiles } from "@plugins/apps/plugins/prototypes/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { originOf } from "@plugins/infra/plugins/request-origin/core";
import { prototypePicks, setPrototypePicks } from "../../core";
import { openPicksStore, type PicksStore } from "../../shared/picks";
import { prototypeExists } from "./paths";

// The server's face of the option-picks store (`shared/picks.ts`): the
// per-prototype picks resource and the one write endpoint.
//
// The writer notifies its own subscribers the moment it writes. Every OTHER
// backend learns through the one watch over the tree (`_picks/<id>.json` →
// `picks-recorded`, `tree-path.ts`) — the store is host-global, so a pick made
// on main has to reach a worktree deploy's open tab, and the reverse.
//
// An automated session's write is undone by the root, not here: the
// `prototypesFiles` root ledgers every agent-origin write under `_picks/`
// (`prototype-picks`), and the harness's restore is heard through the same
// watch, like any other writer's.

/** The store over the app's file root. */
function store(): PicksStore {
  return openPicksStore(prototypesFiles);
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
    if (!(await prototypeExists(name))) {
      throw new Error(`prototypes.picks: no such prototype: ${name}`);
    }
    return store().read(name);
  },
});

/**
 * `PUT /api/prototypes/:name/picks` — apply one change (`set` one option, or
 * `reset` them all). 404 for an unknown prototype. The writer is the request's
 * origin, so an agent session's pick is recorded in the root's ledger, inside
 * the store's lock, around the one write.
 */
export const handleSetPicks = implement(
  setPrototypePicks,
  async ({ params, body, req }) => {
    const { name } = params;
    if (!(await prototypeExists(name))) {
      throw new HttpError(404, `no such prototype: ${name}`);
    }
    await store().write(name, body, originOf(req));
    prototypePicksServed.notify({ name });
  },
);
