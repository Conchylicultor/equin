import type { LiveMachineDecl } from "@plugins/network/plugins/live/core";
import {
  serveAnyValue,
  type ServeValueOverloads,
} from "../../server/internal/serve-value";
import {
  serveAnyCollection,
  type ServeCollectionOverloads,
} from "../../server/internal/serve-collection";

// The desktop-only half of the live API's serving: the same `serveValue` /
// `serveCollection` as `live/server` — the same overload set and the same body
// — over a declaration declared `needsMachine` only, so a read that needs the
// computer is served by a plugin's `machine/` half and nowhere else (and a
// portable declaration is a tsc error here).

/** Serve a `liveValue` declared `needsMachine` — as `live/server`'s `serveValue`. */
export const serveValue: ServeValueOverloads<LiveMachineDecl> =
  serveAnyValue as ServeValueOverloads<LiveMachineDecl>;

/** Serve a `liveCollection` declared `needsMachine` — as `live/server`'s `serveCollection`. */
export const serveCollection: ServeCollectionOverloads<LiveMachineDecl> =
  serveAnyCollection as ServeCollectionOverloads<LiveMachineDecl>;
