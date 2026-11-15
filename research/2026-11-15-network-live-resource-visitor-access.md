# Live resources: visitor access per resource, owner by default

## Context

`d16b747ce7` added the `visitor` principal (anyone through a deployed site's
public edge) and opened the live-state read paths to it as whole ROUTES:
`GET /api/resources/:key`, the `/ws/notifications` socket and
`GET /api/resources/boot-snapshot`. So a visitor to equin.ai can read every
live resource the website composition's backend serves (notifications, dead
jobs, config values, saved themes, Maps settings…), not only what its pages
read. Access must be decided per RESOURCE, denied by default.

## Design

Mirror `EndpointAccess` (`framework/principal`): owner by default (no
spelling), `{ visitor: "<reason>" }` the one opt-in, an empty reason throws at
declaration.

1. **Declaration** — `liveValue(key, { …, access: { visitor } })` and
   `liveCollection(key, { …, access: { visitor } })`. The factories stamp it
   on every descriptor they mint (a collection's window, `:rows`, `:groups`,
   `:count`, `:ancestors`; a paged value's pages and meta) —
   `ResourceDescriptor.access`. The type is principal's `VisitorAccess`
   (`SocketAccess = "owner" | VisitorAccess`).
2. **Runtime** (`resource-runtime`) — `ResourceContract.access` →
   `ResourceDefinition.access` → `RegistryEntry.access`, threaded the way
   `refusals` is. The caller is `"owner" | "visitor"`:
   - HTTP: `createResourceRuntime({ callerOf(req) })` — server-core passes
     principal's new `admittedAs(req)` (not stamped / undeclared → owner, the
     ungated status quo; stamped → owner only on an `owner` stamp, otherwise
     visitor — fail closed). A visitor gets `403 { reason: "unauthorized" }`
     for a key without access, and for `_debug` / the answer trail.
   - Socket: the upgrade records the caller on `ws.data.principal`
     (server-core's `WsData`, required); the runtime reads it at `open`
     (absent → owner: the in-realm browser host, central's owner-only
     socket). `handleSub` / `handleSubBatch` refuse a visitor's sub of a key
     without access with `sub-error { reason: "unauthorized" }` before any
     side effect — the client's HTTP heal then gets the 403.
   - Boot snapshot: `assembleBootSnapshot({ visitor })` keeps only keys whose
     resource declares visitor access (default-tuple and enumerated alike);
     the handler passes `admittedAs(req) === "visitor"`.
3. **Mark exactly what the website's pages read**: build the `website`
   composition, drive every page as the owner recording every key it
   subscribes / reads / boots, mark those, rebuild, drive again as a visitor
   (`X-Forwarded-For` → the gateway stamps `visitor`): every page renders, and
   a non-declared key (notifications, jobs) is refused on all three paths.

No change to the network/live API beyond the declared field.

## Tests

- resource-runtime: visitor socket sub / sub-batch refused, owner admitted,
  declared key admitted; HTTP 403 for a visitor, `_debug` refused.
- principal: `admittedAs` matrix.
- boot-snapshot: visitor assembly drops undeclared keys.
- live core: access stamped on every minted descriptor; empty reason throws.
