# resource-protocol

The live-resource wire protocol, as one leaf both ends compile against: the
frame vocabulary of the `/ws/notifications` socket and its failure vocabulary.
The resource runtime (`framework/resource-runtime`, per-worktree and central)
sends these frames and bodies, the live-state client (`primitives/live-state`)
reads them. A leaf because the runtime barrel pulls `node:crypto` (the browser
cannot import it) and the runtime must not import the live-state client.

## The frame vocabulary is data (`core/internal/frames.ts`)

Every frame the runtime sends a tab (`SERVER_FRAMES`) and every frame a tab
sends the runtime (`CLIENT_FRAMES`), plus the derivation limits, are declared
ONCE as plain data in a tiny spec language (`string`, `number`, `params`,
`literal`, `oneOf`, `nullable`, `array`, `tuple`, `object`, `optional`). Both
ends' types are DERIVED from it — `ServerFrame` (the client's message union),
`ClientFrame`, `SubErrorFrame`, `Derivation` / `DeriveSource` — and the three
that keep each end to it:

- `ExactServerFrame<F>` / `ExactClientFrame<F>` — what the runtime's
  `sendJson` / `broadcastJson` and the client's `wire` take: the frame with
  every field its kind (`op`) does not declare turned into `never`, at every
  depth. A frame type alone would not do: TypeScript checks excess properties
  only on a fresh literal and never on its spreads, so a frame built in a
  variable, or spreading a conditional field, could grow a field that reaches
  the wire without moving the id. `frames.test.ts` pins the refusals
  (`@ts-expect-error`).
- `ReceivedFrame<op>` — how the runtime reads a tab's frame: untrusted, so
  every field optional at every depth, but typed from the vocabulary, so it
  reads no field a tab was never declared to send.

And so is **`PROTOCOL`**: `rp-` + a 53-bit pure-JS hash
(cyrb53, no `node:crypto`, so the browser computes the same id) of the
vocabulary's canonical JSON (keys sorted; a `oneOf` stored sorted).

So a vocabulary change cannot ship without changing the id: a field added or
made optional, a frame kind added, a limit moved are each an edit to the data,
and the id moves with it. An edit that changes nothing on the wire (a comment,
field order) leaves it. What the id decides:

- **Who shares a socket.** live-state's dialect is `PROTOCOL`
  (`SharedWebSocketOptions.dialect`), so tabs share the worker-owned socket
  exactly while they read frames alike — across deploys that did not touch the
  vocabulary, and never across one that did. (The worker's own script URL is
  content-addressed per networking build, so a networking change splits it
  too; see `networking/CLAUDE.md`.)
- **Whether a derivation is trusted.** Every `sub` / `sub-batch` frame names
  its tab's `protocol`; the runtime reads a `sub`'s `derive` only under its own
  (otherwise `protocol-skew`, a full load — `resource-runtime/CLAUDE.md`).

`frames.test.ts` pins it: the id is stable across key order, moves on an added
field / an optional flip / a new kind / a limit, and is snapshot-pinned — a
change of the pin IS a wire change, updated only beside the frame edit that
moved it.

`DERIVE_MAX_SOURCES` (2) and `DERIVE_MAX_ID` (128) live here too, in the hashed
data: the client refuses to send more, the runtime refuses to read more.

## Failure vocabulary (`core/internal/protocol.ts`)

- `SubErrorReason` — `unknown-key` / `unauthorized` / `loader-failed` /
  `contract-mismatch` / `refused`.
- `ContractVerdict` + `contractVerdict(clientBuild, serverGraph)` — whose fault a
  mismatch is: `skew` (the tab runs another bundle; a reload fixes it — absent a
  build, the bundle predates this protocol, which is skew too), `same-build` (a
  real bug), `unknown` (a dev bundle, no served graph, central).
- `ResourceHttpErrorBody` (+ `parseResourceHttpErrorBody`) — the JSON body of
  a failed HTTP read (404 / 409 / 422 / 500); its WS twin is the vocabulary's
  `sub-error` frame (`SubErrorFrame`).
- `RESOURCE_BYTES_CONTENT_TYPE`, `RESOURCE_BYTES_HEADERS`,
  `resourceBytesHeaders(envelope)` / `parseResourceBytesHeaders(key, headers)`
  (`ResourceReadEnvelope`) — a BYTES read (`application/octet-stream`, a
  `liveValue` declared `bytes: true`): its body is the value, so the envelope
  a JSON body carries (`version`, `epoch`, `watermark?`) rides these response
  headers. The parse throws on another content type or a missing / malformed
  version or epoch.
- `BUILD_GRAPH_HEADER` — the header an HTTP read names the client's build in; a
  `sub` / `sub-batch` frame carries the same value as `build`.
- `ResourceContractError` — thrown by a params DECODE (a subscription's wire
  params do not match the declaration). Declaration-time and encode failures stay
  plain `Error`s: those are programmer errors and must crash loudly. The runtime
  refuses such a sub before registering it; see
  `plugins/framework/plugins/resource-runtime/CLAUDE.md`.
- `ResourceRefusal(code, message)` — an EXPECTED, caller-caused refusal a
  LOADER throws (well formed params, but a question that cannot be answered as
  asked: a missing file, an unknown id, an empty range). `code` is one of the
  codes the resource declares (a `liveValue`'s `refusals`). The runtime sends
  both to the reader (`refused`: HTTP 422 `{ code, detail }`, `sub-error`'s
  `code` + `message`) and never reports it as a server failure; the client
  types the code from the same declaration, and reads a code it does not
  declare as a contract mismatch. A code the resource does not declare is a
  server failure (`loader-failed`, reported), like anything else a loader
  throws. Thrown through a declaration's typed `refuse(code, message)`, or
  subclassed per domain (`MetricQueryError`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The live-resource wire protocol, shared by the resource runtime (server, central) and the live-state client: the socket's frame vocabulary declared once as data — ServerFrame / ClientFrame / Derivation types derived from it, and PROTOCOL, a pure-JS hash of its canonical JSON that splits the shared socket and gates seeded derivations exactly when the vocabulary changes — plus the failure vocabulary: the sub-error reasons (contract-mismatch included), the contract verdict (skew / same-build / unknown), the HTTP error body, the client build-graph header, ResourceContractError — the typed throw a params decode raises when a subscription does not match the declaration — and ResourceRefusal, the expected caller-caused refusal a loader throws, whose message reaches the reader and is never reported as a server failure.
- Cross-plugin:
  - Imported by:
    - `framework/resource-runtime`
    - `network/live`
- Core:
  - Exports (types):
    - `ClientFrame`
    - `ContractVerdict`
    - `Derivation`
    - `DeriveSource`
    - `ExactClientFrame`
    - `ExactServerFrame`
    - `ReceivedFrame`
    - `ResourceHttpErrorBody`
    - `ResourceReadEnvelope`
    - `ServerFrame`
    - `SubErrorFrame`
    - `SubErrorReason`
  - Exports (values):
    - `BUILD_GRAPH_HEADER`
    - `contractVerdict`
    - `DERIVE_MAX_ID`
    - `DERIVE_MAX_SOURCES`
    - `DEV_BUILD`
    - `parseResourceBytesHeaders`
    - `parseResourceHttpErrorBody`
    - `PROTOCOL`
    - `RESOURCE_BYTES_CONTENT_TYPE`
    - `RESOURCE_BYTES_HEADERS`
    - `resourceBytesHeaders`
    - `ResourceContractError`
    - `ResourceRefusal`

<!-- AUTOGENERATED:END -->
