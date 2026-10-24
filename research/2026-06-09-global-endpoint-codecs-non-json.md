# Endpoint codecs: typed non-JSON (binary / multipart) payloads

Date: 2026-06-09
Category: global (infra primitive + attachments/screenshot/crashes consumers)

## Context

The `endpoints` primitive (`plugins/infra/plugins/endpoints/`) gives every HTTP
endpoint a single typed contract: `defineEndpoint` declares route + body +
response once, `implement()` derives the server handler, and
`fetchEndpoint`/`useEndpoint`/`useEndpointMutation` derive the typed client — no
hardcoded URL strings, no `as` casts. The server-side migration is **complete**
(the `endpoints:typed-handlers` check has an empty allowlist).

The web side is *almost* complete. The `endpoints:typed-web-fetches` check still
allowlists **6** raw `fetch("/api/…")` call sites. All 6 are genuine
special-transport — the current primitive is hardwired to JSON in / JSON out
(`fetchEndpoint` always `JSON.stringify`s the body + `Content-Type:
application/json`, and decodes via `res.json()` + Zod; `implement` always
`req.json()` + `Response.json()`). So binary uploads, multipart, blob responses,
and the keepalive crash beacon can't use it and fall back to raw `fetch`.

**These are not un-migrated stragglers — they are a transport class the primitive
deliberately doesn't cover.** This plan removes that limitation structurally:
generalize the body/response contract from "a JSON Zod schema" to "a **codec**",
with JSON as the default. A bare Zod schema keeps meaning JSON (all ~217 existing
call sites unchanged); binary/multipart endpoints opt into `blob()` / `multipart()`
in the *same* `body:`/`response:` slot. After this, 5 of the 6 sites flow through
the typed path; the 6th (the polymorphic attachments-list route) is a *route*
problem, not an encoding one, and is deferred to its own task
(`task-1780999772107-z6xhaz`), which also flips the check to unconditional + empty.

Outcome: binary endpoints become first-class and keep `fetchEndpoint`'s URL
derivation, typing, and error handling (the thing every raw site currently
re-implements by hand). The web-fetch allowlist drops from 6 → 1.

## Design

### 1. Codec interface + built-ins (`core/`)

New file `core/codec.ts`:

```ts
export interface Codec<T> {
  // client → server (request body)
  encodeRequest(value: T): { body: BodyInit; contentType?: string };
  decodeRequest(req: Request): Promise<T>;   // throws HttpError(400) on bad payload
  // server → client (response body)
  encodeResponse(value: T): Response;
  decodeResponse(res: Response): Promise<T>;
}

export function isCodec(x: unknown): x is Codec<unknown> {
  return typeof x === "object" && x !== null && "encodeRequest" in x;
}
```

Built-ins (each with an **explicit** return-type annotation — never inferred, see
§4 inference note):

- `json<T>(schema?: ZodType<T>): Codec<T>` — the current behavior, extracted:
  `encodeRequest` → `{ body: JSON.stringify(v), contentType: "application/json" }`;
  `decodeRequest` → `req.json()` then `schema?.safeParse` (throws `HttpError(400,
  …)` with the Zod issues on failure); `encodeResponse` → `Response.json(v)`;
  `decodeResponse` → `res.json()` then `schema?.parse(v)`.
- `blob(contentType?: string): Codec<Blob>` — `encodeRequest` →
  `{ body: v, contentType }`; `decodeRequest` → `req.blob()`; `encodeResponse` →
  `new Response(v, { headers: v.type ? { "content-type": v.type } : {} })`;
  `decodeResponse` → `res.blob()`.
- `multipart(): Codec<FormData>` — **request-only**: `encodeRequest` →
  `{ body: v }` (NO `contentType`, so the browser sets the multipart boundary);
  `decodeRequest` → `req.formData()`. `encodeResponse`/`decodeResponse` throw
  `"multipart is request-only"` (defensive; never used in a `response:` slot).

`text()` / `binary()` (ArrayBuffer) are intentionally **not** added now — zero
consumers; add when first needed. `json` is an *internal* normalizer, not
something callers write (they keep writing bare `z.object(…)`).

### 2. `defineEndpoint` normalization — non-breaking (`core/define-endpoint.ts`)

`body`/`response` accept a Zod schema **or** a codec, in the same slot. `query`
stays `ZodType` (URL params, not a body — no codec).

```ts
type Spec<T> = ZodType<T> | Codec<T>;
type SpecType<S> = S extends Codec<infer U> ? U : S extends ZodType<infer U> ? U : void;
```

`defineEndpoint` infers the **spec object type** (`B`, `R`) from the argument and
extracts the payload type via `SpecType<>` — it does **not** infer the type var
directly from a `ZodType<T> | Codec<T>` union (that regresses inference; see §4).
At runtime it normalizes and stores codecs:

```ts
readonly bodyCodec?: Codec<TBody>;       // replaces bodySchema
readonly responseCodec?: Codec<TResponse>; // replaces responseSchema
// in defineEndpoint(): const bodyCodec = opts.body ? (isCodec(opts.body) ? opts.body : json(opts.body)) : undefined;
```

`querySchema` is unchanged. Existing `dateString()` helper still works (it's a
`z.string()` alias consumed by `json()`).

### 3. `implement()` + `fetchEndpoint()` use the codecs

`core/implement.ts`:
- body decode: `if (bodyCodec) body = await bodyCodec.decodeRequest(req)` — the
  codec throws `HttpError(400)` on bad payload, caught by the existing
  `catch (err) { if (err instanceof HttpError) … }`.
- response encode: keep `undefined|null → 204` **first**, then
  `responseCodec ? responseCodec.encodeResponse(result) : Response.json(result)`.
  (Today `implement` never reads `responseSchema` and always `Response.json`s —
  this is the one *new* server behavior: JSON endpoints get
  `json().encodeResponse` = `Response.json`, identical output.)
- `recordEntrySpan` wraps only the handler call (unchanged); encode stays in the
  same `try`.
- **JsonCompat binary-safety** (the key type subtlety): the handler return type
  stays `JsonCompat<TResponse>`, but add a guard so binary types pass through
  unmangled instead of hitting the `object` branch:

```ts
type JsonCompat<T> =
  T extends string ? string | Date | JsonSerializable :
  T extends Blob | ArrayBuffer | ArrayBufferView | FormData | ReadableStream ? T :  // NEW — before object
  T extends (infer U)[] ? JsonCompat<U>[] :
  T extends object ? { [K in keyof T]: JsonCompat<T[K]> } :
  T;
```

`ArrayBufferView` covers `Uint8Array`/`DataView`. For `response: blob()`,
`TResponse=Blob` → `JsonCompat<Blob>=Blob` (exact). Date→string widening for JSON
objects is preserved. This keeps `EndpointDef`'s 5 type params unchanged (no
second "handler-input" type param threaded through generics).

`web/internal/fetch-endpoint.ts`:
- body encode: `if (bodyCodec && opts.body !== undefined) { const enc =
  bodyCodec.encodeRequest(opts.body); body = enc.body; if (enc.contentType)
  headers["Content-Type"] = enc.contentType; }` — **content-type comes only from
  the codec; no `application/json` fallback** (multipart must stay header-less).
- response decode: `if (res.status === 204 || !responseCodec) return undefined;
  return responseCodec.decodeResponse(res)`.
- add two opts to the (un-exported) `FetchOpts` intersection: `keepalive?:
  boolean` (RequestInit passthrough) and `report?: boolean` (default true; `false`
  skips `reportEndpointError` — required so a failing crash beacon doesn't recurse
  into the crash pipeline). `useEndpoint`/`useEndpointMutation` pass `opts as any`
  and never set these, so defaults apply — no ripple.

### 4. Inference safety (must verify, not assume)

The `Spec`/`SpecType` extractor pattern (inferring the argument's object type, then
conditionally extracting `T`) avoids the union-variance inference regression that a
direct `body?: ZodType<TBody> | Codec<TBody>` signature would cause (`Codec<T>` is
invariant in `T`). Factory functions **must** carry explicit return annotations
(`blob(): Codec<Blob>`). **Validation gate:** before migrating consumers, run
`tsc --noEmit` and confirm a handful of existing `defineEndpoint` sites (e.g.
`plugins/agents/core/endpoints.ts`, `plugins/conversations/core/endpoints.ts`,
`plugins/tasks/core/endpoints.ts`) still infer `TBody`/`TResponse` correctly.

### 5. Migrate the 5 codec-able sites (the 6th is deferred)

| Web site | Endpoint def | body codec | response | Server handler |
|---|---|---|---|---|
| `plugins/crashes/web/report.ts` | `reportCrash` (already json both ways) | — | — | no change (already `implement()`); client adds `keepalive:true`, `report:false`, keeps `try/catch → null` |
| `plugins/infra/plugins/attachments/web/internal/upload.ts` | `uploadAttachment` | `multipart()` | `json(UploadedAttachmentSchema)` | `handle-upload.ts` → `implement()`; keep `instanceof File`, `MAX_SIZE`, empty checks as handler logic |
| `plugins/screenshot/web/components/prompt-form.tsx` | `saveScreenshotFile` | `blob("image/png")` | `json(z.object({ path: z.string() }))` | `handle-save-file.ts` → `implement()`; keep content-type guard |
| `plugins/screenshot/web/components/screenshot-button.tsx` | `createScreenshot` | `blob("image/png")` | `json(z.object({ id: z.string() }))` | `handle-create.ts` → `implement()`; keep content-type guard |
| `plugins/screenshot/web/components/screenshot-view.tsx` | `getScreenshot` | — | `blob()` | `handle-get.ts` **stays raw** (binary response + `cache-control`); client decodes via `blob()`; 404-retry loop now reads `EndpointError.status` |

Client sites import the existing endpoint def and call
`fetchEndpoint`/`useEndpointMutation` — no hardcoded `/api/` string remains.
**Server guards stay in the handler body** (codec does transport only); **binary
GET responses with custom headers keep their raw handler** (bare `blob()` would
drop `cache-control`/`content-disposition`) — only POST (binary/multipart → JSON)
handlers move to `implement()`.

Deferred (separate task `task-1780999772107-z6xhaz`):
`plugins/infra/plugins/attachments/web/internal/list.ts` —
`/api/${ownerType}s/:id/attachments` is a runtime-built route with no literal
`defineEndpoint`; it needs each owner to expose its own list endpoint passed in by
reference. That task also flips the check to unconditional + empty allowlist.

### 6. Check: reduce allowlist 6 → 1 (`check/typed-web-fetches.ts`)

Delete the 5 migrated entries from `ALLOWED`; leave only
`plugins/infra/plugins/attachments/web/internal/list.ts`. Each migrated file has
exactly one raw `/api/` fetch → count goes to 0 (verified). Do **not** leave stale
cap-1 entries. The check stays allowlist-conditional until the 6th task removes
the last entry and tightens it to reject unconditionally.

### 7. Documentation cleanup

- `plugins/infra/plugins/endpoints/CLAUDE.md` — add a "Non-JSON payloads"
  section showing `body: blob("image/png")` / `multipart()` / `response: blob()`
  and noting bare Zod = JSON default. (Autogen block regenerates via build.)
- `plugins/infra/plugins/entity-extensions/CLAUDE.md:42` — replace the raw
  `fetch(...)` example with `fetchEndpoint`/`useEndpointMutation` (active
  developer guidance; highest priority).
- `plugins/screenshot/shared/endpoints.ts` + `plugins/crashes/shared/endpoints.ts`
  — update the "not wrapped with implement()" comments to reflect codec usage.
- `research/2026-05-18-global-define-endpoint.md` — trim now-complete migration
  scaffolding (Phase 1/2/3 strategy lines ~275-291, "Key files to create" table
  ~293-320, the "non-migrated handlers still work side-by-side" comment ~172, and
  "Old hand-written handlers continue working indefinitely" ~285). Update gotcha
  #7 ("special-case endpoints to skip") to note they're now handled via codecs
  except the polymorphic attachments-list route.
- Leave the purely-historical diagnosis docs (`2026-04-26-sync-engine-issues.md`,
  `2026-05-20-cli-buffered-build-logs.md`, `2026-06-02-…`) as past-tense snapshots
  — out of scope.

## Key files

Primitive:
- `plugins/infra/plugins/endpoints/core/codec.ts` (new)
- `plugins/infra/plugins/endpoints/core/define-endpoint.ts` (Spec/SpecType, codec fields, normalize)
- `plugins/infra/plugins/endpoints/core/implement.ts` (codec decode/encode, JsonCompat guard)
- `plugins/infra/plugins/endpoints/web/internal/fetch-endpoint.ts` (codec encode/decode, keepalive/report)
- `plugins/infra/plugins/endpoints/core/index.ts` (export `Codec`, `blob`, `multipart`, `isCodec`)

Consumers:
- `plugins/crashes/web/report.ts`
- `plugins/infra/plugins/attachments/{shared/endpoints.ts, web/internal/upload.ts, server/internal/handle-upload.ts, server/index.ts}`
- `plugins/screenshot/{shared/endpoints.ts, web/components/{prompt-form,screenshot-button,screenshot-view}.tsx, server/internal/{handle-create,handle-save-file}.ts, server/index.ts}`

Check + docs:
- `plugins/infra/plugins/endpoints/check/typed-web-fetches.ts`
- `plugins/infra/plugins/endpoints/CLAUDE.md`, `plugins/infra/plugins/entity-extensions/CLAUDE.md`, `research/2026-05-18-global-define-endpoint.md`

## Verification

1. `tsc --noEmit` (or build typecheck) — confirm existing JSON `defineEndpoint`
   sites still infer body/response (inference gate, §4).
2. `./equin build` — compiles + deploys.
3. `./equin check` — `endpoints:typed-web-fetches` passes with 1 allowlist
   entry (`list.ts`); `endpoints:typed-handlers` still empty; `eslint`,
   `plugins-doc-in-sync` pass.
4. End-to-end at `http://<worktree>.localhost:9000` via `e2e/screenshot.mjs`:
   - Screenshot button → capture → confirm a screenshot row + image loads
     (exercises `createScreenshot` binary POST + `getScreenshot` blob GET).
   - Screenshot prompt-form → launch → confirm `@<path>` resolves
     (`saveScreenshotFile` binary POST).
   - Upload a file attachment on a task → confirm it appears (`uploadAttachment`
     multipart POST).
   - Trigger a client error → confirm a crash task is filed and **no** recursive
     crash-about-the-crash (validates `report:false` + keepalive).
5. Send a malformed multipart/binary body → confirm `HttpError(400)` from the
   codec decode path.
