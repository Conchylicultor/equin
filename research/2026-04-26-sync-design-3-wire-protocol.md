# Sync redesign — sub-design 3: wire protocol & transport

Status: research / option survey
Scope: the bytes-on-the-wire layer of equin's sync system. What flows server↔client, how disconnects are recovered, and what physical transport carries it.

This is a sibling to two other sub-designs (reactivity engine; mutation / write path) — this doc deliberately stays at the wire level and points out where it is constrained by sibling decisions.

---

## 1. Problem restatement

Today every browser tab opens one WebSocket to the worktree's Bun server. The server pushes one of two frame shapes per `(key, params)` resource subscription: `{kind:"update", key, params, value, version}` carrying a *full payload*, or `{kind:"invalidate", key, params, version}` which makes the client re-fetch the same data over HTTP. Initial snapshots are delivered via a `sub-ack` WS frame, but the same data is also fetched over HTTP elsewhere (the conversation list resource, for example, ships a payload over `GET /api/conversations` *and* rides the WS). On reconnect, the client resubscribes everything with `version=0`; there is no replay log, so any update that landed during the gap is observed only as a version jump from `N` to `M`. Issues #3 (granularity), #8 (replay), and #16 (single transport) in [`research/2026-04-26-sync-engine-issues.md`](2026-04-26-sync-engine-issues.md) all live in this layer.

The redesign needs a wire protocol that (a) is fine-grained enough to ship row deltas instead of whole snapshots, (b) lets the server resume a subscription from the exact point the client left off, and (c) doesn't bake in a single transport for every payload size and frequency.

---

## 2. The three big choices (orthogonal axes)

The mature systems we surveyed below all answer three more or less independent questions. It's worth naming them up front, because most disagreements between sync engines reduce to picking different cells in this table — not to one being "better".

### 2a. Protocol unit — what is the atomic thing the wire ships?

| Unit | Examples | Implications |
|---|---|---|
| **Full snapshot** of a query result | Hasura live queries, equin today | Trivially correct. Big payloads. Diff is the *client's* problem (React reconciler, virtualized list keys). Replay = "re-send current truth". |
| **Row delta / patch op** (`put`/`del` keyed by primary key) | Replicache, ElectricSQL Shape Log, PowerSync ops | Need a stable per-row identity. Need the server to know which rows the client *had*. Replay = "resend ops since cursor X". |
| **Op log / mutation log** (named user-level operations + args) | Linear sync actions, Replicache push | Carries semantic intent, not just current values. Useful for audit/CRDT/replay. Requires mutation registry on both sides. |
| **CRDT update** (binary blob with embedded vector clocks) | Yjs, Automerge | Self-merging, no server arbiter required. Opaque to the wire layer; you can't render a CRDT update without applying it. |
| **Signed checkpoint + content-addressed pages** | PowerSync (checksums per bucket), Git-like | Can verify integrity without trusting the channel; cache-friendly (CDN). Heavier protocol. |

Choosing the unit determines what the *next* two axes can look like.

### 2b. Replay strategy — how does a returning client catch up?

| Strategy | Examples | Cost on server |
|---|---|---|
| **Re-sync from scratch** | equin today; Figma for whole document | Trivial server. No bounded "missed events" — clients see only "new truth". |
| **Cookie / opaque resume token** | Replicache (`cookie`), Matrix (`since`), Discord (`session_id` + `seq`) | Server stores enough state per cookie to compute the diff. Cookie may carry a Lamport-ish version. |
| **Op-log catchup from offset** | ElectricSQL (`offset`), PowerSync (`last_op_id`), Linear (`lastSyncId`), Phoenix Channel rejoin | Server keeps an ordered log per topic, capped. Clients past the cap fall back to (a). |
| **Vector-clock / state-vector exchange** | Yjs (`SyncStep1` carries a state vector, server replies with the missing updates) | Symmetric, peer-to-peer friendly. Slightly larger handshake. |
| **Per-subscription checkpoints + checksums** | PowerSync (`StreamingSyncCheckpoint` w/ per-bucket checksums) | Lets client *verify* it has everything; on mismatch, re-sync that bucket. Strongest correctness story. |

A cookie is just a tiny op-log offset. A state vector is a tiny op-log offset, per author. A checkpoint with a checksum is the same offset plus integrity. They sit on a continuum.

### 2c. Physical transport

| Transport | Pros | Cons |
|---|---|---|
| **WebSocket** | Bidi, low overhead per frame, mature server libs (Bun has it). | One TCP connection ⇒ head-of-line blocking. Stateful proxies/load balancers. Some corporate proxies still strip `Upgrade`. |
| **SSE (`text/event-stream`)** | Plain HTTP; trivially cached/proxied; auto-reconnect with `Last-Event-ID`. | Server-to-client only; one stream per origin per browser unless you multiplex; nginx buffers by default ([RxDB analysis](https://rxdb.info/articles/websockets-sse-polling-webrtc-webtransport.html)). |
| **HTTP long-poll / streamed `fetch`** | Works through every middlebox. | Per-request overhead; reconnect logic on the client. |
| **HTTP/2 server push** | Built into the protocol. | Effectively dead — Chrome removed it; spec being deprecated. |
| **WebTransport (HTTP/3 / QUIC)** | Multiplexed streams + datagrams; no HoL blocking; bidi. | Browser support landed in Safari only in 2025; needs HTTP/3 termination at the edge. ([Ably overview](https://ably.com/blog/can-webtransport-replace-websockets)). |

The transport choice is *almost* independent of the unit & replay strategy. ElectricSQL's same shape log can be served as an HTTP request (initial fetch, cacheable) *or* held open as a long-poll for live updates. PowerSync ships the same protocol over [HTTP stream, RSocket/WS, BSON, or JSON](https://docs.powersync.com/architecture/powersync-protocol).

---

## 3. Frameworks surveyed

### 3.1 Replicache (Rocicorp)

Pure HTTP. Two endpoints the application implements: `POST /replicache-push` and `POST /replicache-pull` ([Push reference](https://doc.replicache.dev/reference/server-push), [Pull reference](https://doc.replicache.dev/reference/server-pull)).

**Push request:**
```json
{
  "pushVersion": 1,
  "clientGroupID": "...",
  "mutations": [
    { "clientID": "c1", "id": 42, "name": "createTask", "args": {...}, "timestamp": 1700000000 }
  ],
  "profileID": "...",
  "schemaVersion": "1"
}
```

**Pull request / response:**
```json
// request
{ "pullVersion": 1, "clientGroupID": "...", "cookie": <opaque>, "profileID": "...", "schemaVersion": "1" }

// response
{
  "cookie": <opaque, orderable>,
  "lastMutationIDChanges": { "c1": 42 },
  "patch": [
    { "op": "clear" },
    { "op": "put", "key": "task/abc", "value": {...} },
    { "op": "del", "key": "task/xyz" }
  ]
}
```

- **Unit:** patch ops keyed by string (`put`/`del`/`clear`) for downstream; named mutations with args for upstream.
- **Replay:** opaque server-controlled `cookie`. Client always sends the last cookie it stored; server returns a patch that brings the client from "state-at-cookie-X" to "state-at-cookie-Y". The cookie *is* the replay primitive.
- **Transport:** plain HTTP. Live notification ("hey, pull again") happens over a separate WebSocket "poke" channel — but the actual data only ever travels over HTTP. This decoupling is interesting: the WS is a *doorbell*, not a *delivery truck*.

### 3.2 Zero (Rocicorp, the successor to Replicache)

Sparse public docs; what we have:

- WebSocket from client to **`zero-cache`**; `zero-cache` streams reconciled real-time updates ([deployment](https://zero.rocicorp.dev/docs/deployment), [Solberg notes](https://www.solberg.is/zero)).
- Server keeps a **CVR (Client View Record)** per client tracking "exactly which rows + which versions this client has", so the diff on reconnect is computable without re-shipping the whole query result.
- Mutations go upstream over the same socket; the cache forwards them to a `/push` endpoint on the app backend (so Replicache's `/replicache-push` lives on, but is now an internal hop).
- Updates are derived by **IVM (incremental view maintenance)** in `zero-cache`; the wire ships the row-level diffs IVM produced, not full re-runs.

The point for us: Zero made the unit *finer* than Replicache's key/value patch (it ships row diffs against the actual SQL query) and pushed the replay state to the server (CVR) instead of asking the client to round-trip a cookie. Both choices are paid for by `zero-cache` being a stateful piece of infra.

### 3.3 ElectricSQL

HTTP-based "Shape Log" ([HTTP API](https://electric-sql.com/docs/api/http)). A *shape* is a filtered subset of one Postgres table; the API returns its log of logical operations.

```
GET /v1/shape?table=foo&offset=-1                    # initial fetch
GET /v1/shape?table=foo&live=true&handle=H&offset=0_0 # live tail
```

Each line:
```json
{"headers":{"operation":"insert"},"key":"1","value":{"id":"1","title":"Hello"}}
{"headers":{"control":"up-to-date","global_last_seen_lsn":"0/1234567"}}
```

- **Unit:** logical row operation (`insert`/`update`/`delete`) keyed by a stable PK string, plus `up-to-date` control frames.
- **Replay:** Postgres-LSN-derived `offset`. Client sends `offset=<last>`; server resumes from there. `offset=-1` = "from the start". Once caught up, the server emits `control: up-to-date`, then either closes (initial fetch) or holds open (live mode).
- **Transport:** standard HTTP. Cacheable on a CDN. Live mode is just long-polling / chunked response on the same URL, which is the most aggressively-proxy-friendly choice in the survey.

### 3.4 PowerSync

Bucket-based; clients sync a set of buckets, each is an ordered op log. Multiple transports supported: JSON over HTTP stream, BSON over HTTP, BSON over RSocket, and JSON over WebSocket ([protocol doc](https://docs.powersync.com/architecture/powersync-protocol), [sync-protocol.md](https://github.com/powersync-ja/powersync-service/blob/main/docs/sync-protocol.md)).

Streaming sequence (server→client):

```json
{"checkpoint": {"last_op_id":"...", "write_checkpoint":"...", "buckets":[{"bucket":"users[A]","checksum":...,"count":...}]}}
{"data": { /* SyncBucketData: bucket name + ordered ops */ }}
{"checkpoint_complete": {"last_op_id":"..."}}
```

Then in steady state:
```json
{"checkpoint_diff": {"last_op_id":"...", "updated_buckets":[...], "removed_buckets":[...]}}
{"data": ...}
{"checkpoint_complete": ...}
```

- **Unit:** PUT / REMOVE ops in named buckets; bucket = a parameterised data slice (e.g. `user_todos[user_id]`).
- **Replay:** client opens a session asserting "I have up to `last_op_id` per bucket, with these checksums". Server fast-forwards by streaming missing ops. If the per-bucket checksum disagrees with what the server expects after replay, the client deletes the bucket and re-syncs from zero. This is the strongest *integrity* story in the survey.
- **Transport:** explicitly multiple, swappable. The protocol shape doesn't change; only the framing does.

### 3.5 Linear

WebSocket after a one-shot HTTP bootstrap. Reverse-engineered docs (endorsed by Linear's CTO) at [wzhudev/reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine).

Bootstrap:
```
GET https://client-api.linear.app/sync/bootstrap?type=full&onlyModels=[...]
```
returns a JSON stream ending with:
```json
{"lastSyncId": 2326713666, "subscribedSyncGroups":[...], "databaseVersion": 948, "returnedModelsCount":{"Issue":3,"Team":1}}
```

WS handshake replies with `{"lastSyncId":..., "databaseVersion":...}`. Subsequent **delta packets** carry sync actions:

```json
{"id": 2361610825, "modelName": "Issue", "modelId": "a8e26eed-...", "action": "U", "data": {...}}
```

`action` is one of `I`/`U`/`A`/`D`/`C`/`V` (insert/update/archive/delete/cover/unarchive). Multiple actions arriving together form a **transactional group** — all clients apply them atomically.

- **Unit:** model-level row delta with named action.
- **Replay:** monotonic global `lastSyncId`. On reconnect the WS tells the client the server's current `lastSyncId`; if the client is behind, it requests the missing range. If it's *too* far behind, it does a full bootstrap.
- **Transport:** HTTP for bootstrap, WS for live. Same downstream shape both directions.

### 3.6 Figma

Property-level updates over WebSocket ([2019 blog](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)). Document is `Map<ObjectID, Map<Property, Value>>`; the server tracks "the latest value any client sent for each (object,property)". Last-writer-wins, server picks the order.

- **Unit:** property assignment (object id, property name, value). Not a row delta; finer.
- **Replay:** none — on reconnect the client downloads a fresh document and replays its own offline edits on top. They explicitly chose simplicity over an op log because user-visible outcomes converge.
- **Transport:** WS, one process per document.

This is interesting because it deliberately *doesn't* try to deliver missed events. The reasoning: if there's a 5-minute gap, you don't actually want 5 minutes of paint strokes replayed; you want the current state.

### 3.7 Yjs / Automerge

CRDT updates, binary, framed by `y-protocols`. Three message types ([sync.js / PROTOCOL](https://github.com/yjs/y-protocols)):

```
SyncStep1 (type 0): client sends its state vector (encodeStateVector)
SyncStep2 (type 1): peer replies with the missing updates (encodeStateAsUpdate)
Update    (type 2): incremental updates as they happen
```

Plus an **Awareness** sub-protocol for ephemeral presence (cursors, names) using clock-stamped JSON, dropped after 30s of silence.

- **Unit:** opaque CRDT update (binary). Self-merging by construction.
- **Replay:** state-vector exchange. There's no "server cursor" — both sides discover what the other is missing.
- **Transport:** transport-agnostic; commonly WS via `y-websocket`. Can run over WebRTC, BroadcastChannel, postMessage…

### 3.8 Phoenix Channels

Topic-based pub/sub over WS, JSON arrays as the wire shape ([Channels client guide](https://hexdocs.pm/phoenix/writing_a_channels_client.html)):

```
[join_ref, ref, topic, event, payload]
```

Heartbeat:
```
[null, "2", "phoenix", "heartbeat", {}]
```

Join is just an event named `phx_join`; rejoin after disconnect is the same. There's no built-in "deliver me missed messages" — `Presence` adds a state-snapshot+diff convention on top, but vanilla channels don't replay.

### 3.9 graphql-ws (Apollo-style subscriptions)

WebSocket subprotocol `graphql-transport-ws`. JSON messages with a `type` field ([PROTOCOL.md](https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md)):

```json
{ "type": "connection_init", "payload": {} }
{ "type": "connection_ack" }
{ "id": "<op-id>", "type": "subscribe", "payload": { "query": "...", "variables": {...} } }
{ "id": "<op-id>", "type": "next", "payload": { "data": {...} } }
{ "id": "<op-id>", "type": "complete" }
{ "type": "ping" } / { "type": "pong" }
```

- **Unit:** a full GraphQL `ExecutionResult` per `next` — i.e. a snapshot of the subscription's current value. Hasura's "live queries" plug into this and re-execute the whole query, then send the new result; no row deltas.
- **Replay:** none in the spec. Reconnect = re-init handshake + re-subscribe. Same problem we have today.
- **Transport:** WS only.

### 3.10 Discord Gateway

Big-scale event stream with explicit resume ([Gateway docs](https://docs.discord.com/developers/topics/gateway)).

```json
// Identify
{ "op": 2, "d": { "token":"...", "intents":513, "properties":{...} } }

// Resume
{ "op": 6, "d": { "token":"...", "session_id":"...", "seq": 1337 } }

// Heartbeat
{ "op": 1, "d": 42 }
```

Every event carries a sequence number `s`. After a disconnect, client opens a new socket to `resume_gateway_url` and sends `Resume` with the last `seq`; server replays everything from then, terminating with a `Resumed` event. If the session is too old, server returns Invalid Session and client must Identify (cold-start) again.

This is the crisp cookie-style replay design adapted to a high-volume event bus.

### 3.11 Matrix `/sync`

Long-poll HTTP. Client sends `GET /sync?since=<token>&timeout=30000`; server holds the connection until events appear or timeout, then responds with new events plus a `next_batch` token to use as the next `since` ([sync tutorial](https://uhoreg.gitlab.io/matrix-tutorial/sync.html)).

- **Unit:** room events (typed structs).
- **Replay:** `since` token. First call omits it (cold start); each response gives `next_batch`.
- **Transport:** plain HTTP. No WS in the spec (Matrix has experimented with WS and SSE variants, but `/sync` long-poll is the canon). Survives every middlebox.

---

## 4. Cross-framework comparison

| Framework | Protocol unit | Transport | Replay mechanism | Partial sync / pagination | Ordering | Bin/JSON |
|---|---|---|---|---|---|---|
| equin (today) | Full snapshot per `(key,params)` or "invalidate, refetch" | WS | None — resub everything at v=0 | Bake into params | Per-resource version | JSON |
| Replicache | KV patch ops (`put`/`del`/`clear`) | HTTP push/pull + WS doorbell | Opaque server cookie | Server picks Client View | Server-defined; mutations have monotonic id | JSON |
| Zero | Row-level diffs from IVM | WS | Server-side CVR | Per-query, IVM driven | Server | JSON-ish (compact) |
| ElectricSQL | Row-op log (`insert`/`update`/`delete`) | HTTP (initial + long-poll live) | LSN-derived `offset` | Per-shape; many shapes per table | Postgres LSN | JSON |
| PowerSync | Bucket op log (`PUT`/`REMOVE`) + checksums | HTTP / WS / RSocket; JSON or BSON | `last_op_id` per bucket; checksums catch corruption | Per-bucket | `op_id` monotonic per bucket | JSON or BSON |
| Linear | Model-level sync action | HTTP bootstrap + WS deltas | Global `lastSyncId` | Sync groups | Global monotonic | JSON |
| Figma | (object, property) assignment | WS | None — re-fetch document | Per-document process | Server-assigned | Binary |
| Yjs | CRDT update (binary blob) | WS / WebRTC / anything | State vector (`SyncStep1/2`) | None at protocol level | CRDT clock | Binary |
| Phoenix Channels | Topic event | WS | None built-in | Per-topic | None | JSON |
| graphql-ws | Full `ExecutionResult` | WS | None | Variables in the query | None | JSON |
| Discord | Typed event with `seq` | WS | `session_id` + `seq` resume | None — fixed event types | Monotonic per session | JSON (Etf optional) |
| Matrix `/sync` | Room event | HTTP long-poll | `since` token | `filter` param | Per-room | JSON |

The pattern: every system that survives disconnects cleanly has *some* monotonic cursor (cookie / offset / seq / LSN / state vector) that the client returns on reconnect, and the server can compute "what's new since X" against. The systems that don't (Figma, Phoenix vanilla, graphql-ws, current equin) just re-snapshot.

---

## 5. Options for equin

Three architectures worth designing in detail. None of them require the full Zero / PowerSync stack — equin is single-user and single-process per worktree, so we can make simpler choices than a cloud sync engine.

### Option A — JSON delta-stream over SSE, with separate HTTP for initial snapshot

Inspired by ElectricSQL's "two URLs, one for cold-start, one to tail".

**Initial fetch** (cacheable, plain GET):
```
GET /api/sync/conversations?params=<json>
→ 200
  ETag: "v=1734"
  Content-Type: application/json
  { "snapshot": [ {row}, {row}, ... ], "version": 1734 }
```

**Live tail** (held-open SSE):
```
GET /api/sync/conversations?params=<json>&since=1734
Accept: text/event-stream
→
event: patch
id: 1735
data: {"op":"upsert","key":"abc","row":{...}}

event: patch
id: 1737
data: {"op":"delete","key":"xyz"}

event: heartbeat
id: 1737
data: {}
```

The `id:` field is the SSE `Last-Event-ID` — the browser's built-in `EventSource` automatically sends it back as `Last-Event-ID:` on reconnect, so the resume loop is "free". On the server, "give me everything for resource R since version V" needs a small ring buffer per resource (last N versions of patches — see sub-design 1 on reactivity for whether the engine can even *produce* row-level patches).

Pros:
- HTTP everything. The gateway already proxies HTTP; nothing new to terminate.
- Initial snapshot is a normal HTTP response → can be cached, can be inspected in DevTools, can be fetched server-side during SSR/initial paint.
- `Last-Event-ID` resume is built into browsers.
- Each resource is a separate stream. No multiplexing bug surface.

Cons:
- N resources = N open HTTP streams. Browsers cap at 6 per origin over HTTP/1.1; HTTP/2 (which Bun and the gateway both speak) lifts this dramatically but costs us a multiplex layer in the proxy.
- nginx-style proxies buffer SSE by default. The gateway must opt out (`X-Accel-Buffering: no` or equivalent). This is a one-time fix but a real foot-gun.
- Mutations still need a separate `POST /api/...` round trip (or a separate WS) — SSE is server→client only.

### Option B — Binary op-log over WebSocket with checkpoint-based replay

Inspired by PowerSync + Discord.

A single WS per tab carrying multiplexed subscriptions. Frames are a tagged union; we'd serialize with msgpack or just stay JSON for v1.

**Upstream** (client→server):
```json
{ "type":"sub",   "id":"s17", "key":"conversations", "params":{}, "since":{"op_id":1734} }
{ "type":"unsub", "id":"s17" }
{ "type":"mutate", "id":"m9", "name":"task.create", "args":{...} }     // sub-design 2 territory
{ "type":"ack", "op_id": 1740 }                                          // flow control
{ "type":"ping", "ts": 1234 }
```

**Downstream** (server→client):
```json
{ "type":"sub_ok",   "id":"s17", "op_id":1740, "checksum":"a3f..." }
{ "type":"data",     "id":"s17", "ops":[
    {"op":"upsert","key":"abc","row":{...}},
    {"op":"delete","key":"xyz"}
  ], "op_id": 1741
}
{ "type":"checkpoint","id":"s17","op_id":1741,"checksum":"b27..."}
{ "type":"sub_err",  "id":"s17", "code":"GONE", "msg":"resync required" }
{ "type":"pong", "ts": 1234 }
```

On reconnect the client re-sends every active `sub` with the last `op_id` it saw. The server either fast-forwards from its per-resource ring buffer, or replies `GONE` and the client cold-starts that subscription via a separate snapshot fetch (could be the same WS `sub` with `since: null`, or a sibling HTTP route for the SSR/cache benefits).

Pros:
- One connection, one heartbeat, one reconnect. Operationally the simplest.
- Clear separation between "send me a delta from X" (cheap) and "I lost the cursor, resync me" (cold start) — same as Discord's Resume vs Identify split.
- Per-subscription `checkpoint` with a checksum lets us catch the case where notify-fan-out missed an event and the client silently drifted (issue #1 / #4).
- Mutations and reads share the same socket and the same ordering.

Cons:
- Still single TCP. Head-of-line blocking on a slow loader stalls every other subscription.
- We have to write the multiplex bookkeeping ourselves (subscription ids, ack tracking, backpressure). Today `SharedWebSocket` does some of this but the `sub-ack`/`update`/`invalidate` triplet is too coarse.
- Initial paint needs the WS open before the first byte of data arrives. We'd lose the ability to render server-side or warm a cache from a plain GET.

### Option C — Hybrid: SSE for downstream, HTTP for everything else

Steal the best parts of A and B.

- **Initial fetch:** plain `GET /api/q/<resource>?params=...` returning `{ snapshot, op_id, checksum }`. Cache-friendly, SSR-friendly, debuggable in DevTools.
- **Live tail:** SSE per resource (or one multiplexed SSE channel keyed by sub id), resumed via `Last-Event-ID` = `op_id`.
- **Mutations:** plain `POST /api/m/<mutation>` with a client-generated mutation id. Response is `{ accepted_at_op_id }`. Sub-design 2 (mutations) can layer optimistic-update plumbing on top.
- **Doorbell only on WS** (optional): if SSE-per-resource scales badly, a single tiny WS per tab can carry just `{kind:"poke", subs:["s17","s18"]}` notifications and the client decides whether to re-pull. (This is exactly Replicache's split: WS rings the bell, HTTP delivers the package.)

Pros:
- Maps cleanly onto the gateway (all HTTP).
- Each transport role is small and replaceable.
- Easiest to evolve: we can start with SSE-only, add a poke-WS later when fan-out grows.
- Leaves room for an HTTP/3 / WebTransport upgrade for the SSE part later, since the protocol shape doesn't depend on the framing.

Cons:
- Three primitives instead of one — more surfaces to keep healthy.
- Resource-per-stream model means a 50-subscription tab opens 50 SSE responses. With HTTP/2 this is fine; over the gateway's current proxy path we should measure first.

### Constraint sanity check

| Constraint | Implication |
|---|---|
| Single-tenant local app | We don't need CDN cacheability or multi-region replication. PowerSync's checksum-per-bucket is overkill; a per-resource ring buffer of recent ops is enough. |
| Gateway proxy in front | Avoid anything that requires sticky sessions across worktrees. Every transport choice must survive an in-place server restart (today's WS doesn't, the gateway just kills it). |
| Multiple worktrees | Each worktree is its own server; each tab talks to one worktree. The wire protocol doesn't need to span worktrees. Switching worktrees in the toolbar = open new connection(s). |
| Modest scale | Tens of subscriptions per tab, never hundreds of tabs. We can pick clarity over compression. |
| Bun + Go gateway | Bun has solid WS and HTTP/2; the Go gateway's reverse proxy already handles WS upgrades and chunked HTTP. Either path is well-trodden. |

---

## 6. Open questions (cross-sub-design)

1. **Is the unit even "row delta" derivable?** Sub-design 1 (reactivity engine) decides whether resources can produce a per-row diff at all, or just a recomputed snapshot. If it's the latter, options A/B/C are forced back to "send the whole snapshot, with a cookie" — which is still a strict improvement over today, but loses a lot of the value of fine-grained patches. Zero gets row deltas because IVM produces them; ElectricSQL gets them because Postgres logical decoding does. equin's loaders are arbitrary TS functions today — the reactivity sub-design has to address this directly.

2. **What is the upstream shape?** Sub-design 2 (mutations / write path) decides whether mutations are named operations with args (Replicache/Zero/Linear) or arbitrary HTTP POSTs (current equin). If it's the former, the wire protocol in option B should carry them as a `mutate` frame with a client-generated id, so optimistic UI and server reconciliation share an identifier. If it's the latter, mutations stay on plain HTTP and the WS/SSE channel is purely downstream + acks.

3. **Do we want server-defined ordering or causal ordering?** Linear chose a single global `lastSyncId`; Yjs chose per-author state vectors; PowerSync chose per-bucket op ids. equin is single-process per worktree, so a single monotonic counter would work — but this couples every resource's resume cursor to a global write counter. Per-resource counters are slightly more bookkeeping but isolate hot resources from each other.

4. **Replay-buffer eviction policy?** Whatever the cursor, the server needs to keep "ops since X" in memory long enough for laptop-sleeps to complete. A 5-minute sleep is normal; a meeting-length 30-minute gap is plausible. PowerSync's "if you fall off the buffer, resync from scratch with checksum verification" is a clean fallback worth copying.

5. **Heartbeat / liveness per-subscription?** Issue #8 calls out that today there's no per-subscription health signal. Discord's Heartbeat opcode covers the *connection*, not individual subscriptions. The right answer might be: server emits a `checkpoint` frame for every active sub on a keepalive timer (e.g. every 15s with no real ops), so each sub's resume cursor stays fresh and the client can detect a stuck loader independently.

6. **Backpressure?** None of the surveyed JSON-over-WS protocols implement explicit window management; they rely on TCP. WebTransport's per-stream credits would change this, but Safari only just added support. For equin at modest scale, TCP-level backpressure plus a `pause`/`resume` per-subscription frame is probably enough — but it should be in v1 of the protocol so we don't have to retrofit it.

---

### Sources

- Replicache: [How Replicache Works](https://doc.replicache.dev/concepts/how-it-works), [Push reference](https://doc.replicache.dev/reference/server-push), [Pull reference](https://doc.replicache.dev/reference/server-pull)
- Zero: [docs.deployment](https://zero.rocicorp.dev/docs/deployment), [Notes by Jökull Sólberg](https://www.solberg.is/zero), [Marmelab review](https://marmelab.com/blog/2025/02/28/zero-sync-engine.html)
- ElectricSQL: [HTTP API](https://electric-sql.com/docs/api/http)
- PowerSync: [Protocol overview](https://docs.powersync.com/architecture/powersync-protocol), [sync-protocol.md](https://github.com/powersync-ja/powersync-service/blob/main/docs/sync-protocol.md)
- Linear: [reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine), [Scaling the Linear Sync Engine](https://linear.app/blog/scaling-the-linear-sync-engine), [Tuomas Artman talk](https://www.youtube.com/watch?v=Vk15EYX6C8g)
- Figma: [How Figma's multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)
- Yjs: [y-protocols](https://github.com/yjs/y-protocols)
- Phoenix Channels: [Writing a Channels client](https://hexdocs.pm/phoenix/writing_a_channels_client.html)
- graphql-ws: [PROTOCOL.md](https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md)
- Discord Gateway: [docs](https://docs.discord.com/developers/topics/gateway)
- Matrix `/sync`: [tutorial](https://uhoreg.gitlab.io/matrix-tutorial/sync.html)
- Transport tradeoffs: [RxDB comparison](https://rxdb.info/articles/websockets-sse-polling-webrtc-webtransport.html), [Ably on WebTransport](https://ably.com/blog/can-webtransport-replace-websockets), [WebSocket.org choose-a-protocol](https://websocket.org/tools/choose-a-protocol/)
