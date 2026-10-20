// The live-resource socket's FRAME vocabulary — every frame the resource
// runtime sends a tab and every frame a tab sends it — declared ONCE, as data.
// The TypeScript types both ends compile against are derived from that data
// (`ServerFrame`, `ClientFrame`, `Derivation`, …), and so is `PROTOCOL`, the id
// the shared socket is split by: a hash of the vocabulary's canonical JSON.
//
// The point of declaring it as data rather than as interfaces: a vocabulary
// change cannot ship without changing the protocol id. A field added to a
// frame, a frame kind added, a limit raised — each is an edit to the data
// below, and the id moves with it, so tabs that read frames differently stop
// sharing a socket (and the server stops trusting a derivation asked under
// another vocabulary). An edit that changes nothing on the wire (a comment, the
// order fields are written in) leaves the id where it is.

import { hash53 } from "@plugins/packages/plugins/string-hash/core";

/** Params as they ride the wire: every name → a string. */
export type WireParams = Record<string, string>;

// ── The spec language ──────────────────────────────────────────────────────
// Deliberately tiny: the shapes the socket carries, nothing more. Plain JSON
// data, so the vocabulary IS its own canonical form (see `protocolIdOf`).

type Scalar = "string" | "number" | "boolean" | "unknown" | "params";

/** One wire value's shape. */
export type WireSpec =
  | { readonly t: Scalar }
  | { readonly t: "literal"; readonly v: string | number | boolean }
  | { readonly t: "oneOf"; readonly v: readonly string[] }
  | { readonly t: "nullable"; readonly of: WireSpec }
  | { readonly t: "array"; readonly of: WireSpec }
  | { readonly t: "tuple"; readonly of: readonly WireSpec[] }
  | { readonly t: "object"; readonly fields: WireFields };

/** A field of an object: a value, or one the frame may leave out. */
type FieldSpec = WireSpec | { readonly t: "optional"; readonly of: WireSpec };

type WireFields = { readonly [name: string]: FieldSpec };

const scalar = <T extends Scalar>(t: T) => ({ t }) as const;

/** The spec constructors. */
const w = {
  string: scalar("string"),
  number: scalar("number"),
  boolean: scalar("boolean"),
  /** A resource value: its shape is the resource's schema, not the socket's. */
  unknown: scalar("unknown"),
  params: scalar("params"),
  literal: <const V extends string | number | boolean>(v: V) =>
    ({ t: "literal", v }) as const,
  /** A closed set of strings — stored sorted: a set, so its order is no part of it. */
  oneOf: <const V extends readonly string[]>(v: V) =>
    ({ t: "oneOf", v: [...v].sort() as unknown as V }) as const,
  nullable: <const S extends WireSpec>(of: S) =>
    ({ t: "nullable", of }) as const,
  array: <const S extends WireSpec>(of: S) => ({ t: "array", of }) as const,
  tuple: <const S extends readonly WireSpec[]>(...of: S) =>
    ({ t: "tuple", of }) as const,
  object: <const F extends WireFields>(fields: F) =>
    ({ t: "object", fields }) as const,
  optional: <const S extends WireSpec>(of: S) =>
    ({ t: "optional", of }) as const,
};

/** A frame: an object discriminated by `field` (`kind` server→tab, `op` tab→server). */
const frame = <
  const D extends "kind" | "op",
  const K extends string,
  const F extends WireFields,
>(
  field: D,
  name: K,
  fields: F,
) =>
  w.object({ ...fields, [field]: w.literal(name) } as F & {
    readonly [P in D]: { readonly t: "literal"; readonly v: K };
  });

// ── Derived types ──────────────────────────────────────────────────────────

/** The TypeScript type a spec describes. */
export type WireOf<S> = S extends { t: "string" }
  ? string
  : S extends { t: "number" }
    ? number
    : S extends { t: "boolean" }
      ? boolean
      : S extends { t: "unknown" }
        ? unknown
        : S extends { t: "params" }
          ? WireParams
          : S extends { t: "literal"; v: infer V }
            ? V
            : S extends { t: "oneOf"; v: readonly (infer V)[] }
              ? V
              : S extends { t: "nullable"; of: infer O }
                ? WireOf<O> | null
                : S extends { t: "array"; of: infer O }
                  ? readonly WireOf<O>[]
                  : S extends { t: "tuple"; of: infer O }
                    ? { readonly [I in keyof O]: WireOf<O[I]> }
                    : S extends { t: "object"; fields: infer F }
                      ? ObjectOf<F>
                      : never;

type OptionalKeys<F> = {
  [K in keyof F]: F[K] extends { t: "optional" } ? K : never;
}[keyof F];

type ObjectOf<F> = Flat<
  { readonly [K in Exclude<keyof F, OptionalKeys<F>>]: WireOf<F[K]> } & {
    readonly [K in OptionalKeys<F>]?: F[K] extends { of: infer O }
      ? WireOf<O>
      : never;
  }
>;

type Flat<T> = { [K in keyof T]: T[K] } & {};

// ── The vocabulary ─────────────────────────────────────────────────────────

/** Why a subscription (or its HTTP read) was refused — see `SubErrorReason`. */
export const SUB_ERROR_REASONS = [
  "unknown-key",
  "unauthorized",
  "loader-failed",
  "contract-mismatch",
  "refused",
] as const;

/** Whose fault a contract mismatch is — see `ContractVerdict`. */
export const CONTRACT_VERDICTS = ["skew", "same-build", "unknown"] as const;

/** The most sources a derivation names: a page split reads one, a merge two. */
export const DERIVE_MAX_SOURCES = 2;
/** The longest derivation id the runtime accepts (the client mints UUIDs). */
export const DERIVE_MAX_ID = 128;

/**
 * One source of a seeded derivation (a `sub` frame's `derive.from` entry): a
 * tuple of the same resource the tab holds at `version`, and the slice of its
 * rows the new tuple is — those after the row `after` (exclusive; `null` =
 * from its first row) through the row `until` (inclusive; `null` = through the
 * end of its RANGE, which only a source that is not full holds whole). Rows are
 * named by id (`keyOf`), in the source's window order.
 */
const deriveSource = w.object({
  params: w.params,
  version: w.number,
  after: w.nullable(w.string),
  until: w.nullable(w.string),
});

/**
 * A `sub` frame's `derive`: the id its tab minted for this derivation (echoed
 * by the derived ack — opaque to the runtime, at most `DERIVE_MAX_ID` chars)
 * and its sources, at most `DERIVE_MAX_SOURCES`.
 */
const derivation = w.object({ id: w.string, from: w.array(deriveSource) });

/** Co-produced push timing on an update / delta frame (see `timing` above). */
const FRAME_TIMING = w.object({
  changedAt: w.number,
  sentAt: w.number,
  deliverMs: w.number,
});

const s = <const K extends string, const F extends WireFields>(
  kind: K,
  fields: F,
) => frame("kind", kind, fields);
const c = <const K extends string, const F extends WireFields>(
  op: K,
  fields: F,
) => frame("op", op, fields);

/**
 * Every frame the runtime sends a tab. The shared socket fans each one out to
 * every tab on it, so every tab on one socket must read all of them alike —
 * which is what sharing a `PROTOCOL` means.
 *
 * - `etag` (conditional revalidation): the fresh content signature beside a
 *   full value, for a resource that declares `revalidate`; echoed on the next
 *   (re)subscribe / conditional GET.
 * - `id` + `tabId` (an answer frame — sub-ack, up-to-date, sub-error): the
 *   request it answers, as the asking tab's own `id` and the `tabId` it sent.
 *   Ids are per tab, so only the pair names one request on a shared socket —
 *   a tab reads a frame as ITS answer only when both match (the unanswered-sub
 *   deadline). Absent on an unsolicited frame (a refusal or eviction broadcast
 *   to every holder).
 * - `epoch`: the server's boot identity, on every ack frame — echoed with the
 *   sub's version on a replay so a same-boot server can answer `up-to-date`.
 * - `watermark` (Rule B′): the xid8 snapshot floor a FULLY reconciling value
 *   was read under — sub-ack, update, full keyed delta; never a scoped delta.
 * - `ackTx`: the source-transaction ids a feed-driven recompute folded in.
 * - `timing` (update / delta only): when the change behind a pushed frame
 *   happened and when the frame left — `changedAt` (wall-clock epoch ms of the
 *   change), `sentAt` (wall-clock epoch ms the frame was sent) and `deliverMs`
 *   (first notify → send, on the server's monotonic clock). One object so a
 *   frame cannot carry a change time without the send time that splits its
 *   latency into server and transport layers. Absent on every frame no change
 *   stands behind (catch-up replay, a forced resubscribe's answer, …).
 */
const SERVER_FRAMES = {
  /** Keepalive, carrying how long the server's running flush has been open (0 idle). */
  ping: s("ping", { flushOpenMs: w.number }),
  "sub-error": s("sub-error", {
    id: w.optional(w.number),
    tabId: w.optional(w.string),
    key: w.string,
    params: w.params,
    reason: w.oneOf(SUB_ERROR_REASONS),
    /** On `contract-mismatch` / `unknown-key` — both are what skew looks like. */
    verdict: w.optional(w.oneOf(CONTRACT_VERDICTS)),
    /** On `refused`: the refusal's declared code (`ResourceRefusal.code`). */
    code: w.optional(w.string),
    /** On `refused`: the refusal's user-readable message. */
    message: w.optional(w.string),
  }),
  "sub-ack": s("sub-ack", {
    id: w.optional(w.number),
    tabId: w.optional(w.string),
    key: w.string,
    params: w.params,
    value: w.unknown,
    version: w.number,
    etag: w.optional(w.string),
    watermark: w.optional(w.string),
    epoch: w.string,
  }),
  /**
   * A DERIVED sub-ack: the tuple's value is the slice the asking tab's
   * derivation named, of rows it already holds — so no value rides it. It
   * echoes that derivation's id: a tab holding the same tuple through another
   * request adopts only an answer to its own. No etag (no read ran), no
   * watermark (the slice was cut from snapshots that vouch for no floor).
   */
  "sub-ack-derived": s("sub-ack", {
    id: w.optional(w.number),
    tabId: w.optional(w.string),
    key: w.string,
    params: w.params,
    version: w.number,
    epoch: w.string,
    derived: w.object({ id: w.string }),
  }),
  /**
   * A BYTES resource's sub-ack (`ResourceDefinition.bytes`): no value — an
   * ArrayBuffer never rides a JSON frame — so no etag or watermark either
   * (each describes a value). The client reads the value over HTTP.
   */
  "sub-ack-bytes": s("sub-ack", {
    id: w.optional(w.number),
    tabId: w.optional(w.string),
    key: w.string,
    params: w.params,
    version: w.number,
    epoch: w.string,
  }),
  /** "Your cached value is still current" — the WS twin of HTTP 304. */
  "up-to-date": s("up-to-date", {
    id: w.optional(w.number),
    tabId: w.optional(w.string),
    key: w.string,
    params: w.params,
    version: w.number,
    epoch: w.string,
  }),
  /** One frame answering every already-current entry of a `sub-batch`. */
  "up-to-date-batch": s("up-to-date-batch", {
    epoch: w.string,
    /** The tab whose `sub-batch` this answers; each entry echoes its `id`. */
    tabId: w.optional(w.string),
    entries: w.array(
      w.object({
        id: w.optional(w.number),
        key: w.string,
        params: w.params,
        version: w.number,
      }),
    ),
  }),
  update: s("update", {
    key: w.string,
    params: w.params,
    value: w.unknown,
    version: w.number,
    etag: w.optional(w.string),
    watermark: w.optional(w.string),
    ackTx: w.optional(w.array(w.string)),
    timing: w.optional(FRAME_TIMING),
  }),
  /**
   * A keyed delta. `order` present: the authoritative id order (rebuild);
   * absent: in-place upserts, membership unchanged.
   */
  delta: s("delta", {
    key: w.string,
    params: w.params,
    upserts: w.array(w.tuple(w.string, w.unknown)),
    deletes: w.array(w.string),
    order: w.optional(w.array(w.string)),
    version: w.number,
    watermark: w.optional(w.string),
    ackTx: w.optional(w.array(w.string)),
    timing: w.optional(FRAME_TIMING),
  }),
  invalidate: s("invalidate", {
    key: w.string,
    params: w.params,
    version: w.number,
  }),
  /** A version-less mutation ack: a recompute changed nothing, but the writer's ack must not hang. */
  ack: s("ack", {
    key: w.string,
    params: w.params,
    ackTx: w.array(w.string),
  }),
} as const;

/**
 * Every frame a tab sends the runtime. `tabId` names the client holding the
 * subs; `build` the bundle's build graph (judges a contract mismatch);
 * `protocol` the vocabulary the tab reads (`PROTOCOL` — a derivation is
 * trusted only under the server's own).
 */
const CLIENT_FRAMES = {
  sub: c("sub", {
    id: w.number,
    key: w.string,
    params: w.params,
    etag: w.optional(w.string),
    /**
     * The version echo (`version` at the server boot `epoch`): a sub already
     * current there is answered `up-to-date`. The runtime honours it on any
     * sub; the client sends it only in a replay (`sub-batch`).
     */
    version: w.optional(w.number),
    epoch: w.optional(w.string),
    /** A fresh sub only: seeded from rows this tab holds. */
    derive: w.optional(derivation),
    acks: w.optional(w.boolean),
    tabId: w.string,
    build: w.string,
    protocol: w.string,
  }),
  /** One tab's whole sub set (a replay); `complete` reconciles away the rest. */
  "sub-batch": c("sub-batch", {
    tabId: w.string,
    build: w.string,
    protocol: w.string,
    epoch: w.optional(w.string),
    complete: w.boolean,
    entries: w.array(
      w.object({
        id: w.number,
        key: w.string,
        params: w.params,
        etag: w.optional(w.string),
        version: w.optional(w.number),
        acks: w.optional(w.boolean),
      }),
    ),
  }),
  unsub: c("unsub", { key: w.string, params: w.params, tabId: w.string }),
  "sub-acks": c("sub-acks", {
    key: w.string,
    params: w.params,
    acks: w.boolean,
    tabId: w.string,
  }),
  /** The tab left: release every sub it holds on this socket. */
  "unsub-tab": c("unsub-tab", { tabId: w.string }),
} as const;

/** The whole vocabulary — what `PROTOCOL` is the hash of. */
export const VOCABULARY = {
  server: SERVER_FRAMES,
  client: CLIENT_FRAMES,
  limits: {
    deriveMaxSources: DERIVE_MAX_SOURCES,
    deriveMaxId: DERIVE_MAX_ID,
  },
} as const;

type Frames<T> = { [K in keyof T]: WireOf<T[K]> }[keyof T];

/** Every frame the runtime sends a tab (`sendJson` / `broadcastJson`). */
export type ServerFrame = Frames<typeof SERVER_FRAMES>;
/** Every frame a tab sends the runtime. */
export type ClientFrame = Frames<typeof CLIENT_FRAMES>;
/** The `sub-error` frame the runtime sends when it refuses (or drops) a sub. */
export type SubErrorFrame = WireOf<(typeof SERVER_FRAMES)["sub-error"]>;
/** A `sub` frame's seeded derivation. */
export type Derivation = WireOf<typeof derivation>;
/** One source of a {@link Derivation}. */
export type DeriveSource = WireOf<typeof deriveSource>;

// ── Exactly the vocabulary ─────────────────────────────────────────────────
// A frame type alone does not stop a SENDER adding a field: TypeScript checks
// excess properties only on a fresh object literal, and not on its spreads — a
// frame built into a variable (`const msg = { kind: "update", …, shard }`) or
// spreading a conditional field would compile, and reach the wire without
// moving `PROTOCOL`. So every send takes its frame through `Exact…Frame<F>`,
// which turns each field the frame's kind does not declare into `never`,
// however the object was built. And a RECEIVER reads a frame through
// `ReceivedFrame<op>`, so it cannot read a field no frame declares either.

type KeysOf<T> = T extends unknown ? keyof T : never;
type FieldOf<S, K> = S extends unknown
  ? K extends keyof S
    ? S[K]
    : never
  : never;

/**
 * `F` with every field the declared shape `S` lacks turned into `never`, at
 * every depth (arrays element-wise; an opaque `unknown` value is not looked
 * into). Mapped over `keyof F`, so optionality survives.
 */
type Exact<F, S> = unknown extends S
  ? F
  : F extends readonly (infer E)[]
    ? S extends readonly (infer SE)[]
      ? F & readonly Exact<E, SE>[]
      : F
    : F extends object
      ? F & {
          readonly [K in keyof F]: K extends KeysOf<S>
            ? Exact<F[K], FieldOf<S, K>>
            : never;
        }
      : F;

type OnlyDeclared<U, D extends PropertyKey, F extends U> = Exact<
  F,
  Extract<U, { readonly [P in D]: F[D & keyof F] }>
>;

/** A server frame carrying no field its `kind` does not declare (`sendJson` / `broadcastJson`). */
export type ExactServerFrame<F extends ServerFrame> = OnlyDeclared<
  ServerFrame,
  "kind",
  F
>;
/** A tab frame carrying no field its `op` does not declare (the client's sends). */
export type ExactClientFrame<F extends ClientFrame> = OnlyDeclared<
  ClientFrame,
  "op",
  F
>;

/**
 * `T` as it arrives off the socket: untrusted JSON shaped like it, so every
 * field may be absent at every depth (each read checks its own). `params` stay
 * as declared — the runtime canonicalizes them before anything reads them.
 */
type Received<T> = T extends readonly (infer E)[]
  ? Received<E>[]
  : T extends object
    ? {
        -readonly [K in keyof T]?: K extends "params" ? T[K] : Received<T[K]>;
      }
    : T;

/**
 * A tab→server frame of one `op` as the runtime RECEIVES it — typed from the
 * vocabulary, so the runtime reads no field a tab was never declared to send.
 */
export type ReceivedFrame<Op extends ClientFrame["op"]> = Received<
  Extract<ClientFrame, { readonly op: Op }>
>;

// ── The protocol id ────────────────────────────────────────────────────────

/** JSON with every object's keys sorted: one spelling per value. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** The protocol id of a vocabulary: a hash of its canonical JSON. */
export function protocolIdOf(vocabulary: unknown): string {
  // cyrb53 (`hash53`, seed 0): plain JS, so the browser computes the same id.
  // Not cryptographic — it tells vocabularies apart, it does not defend
  // against a forged one.
  return `rp-${hash53(canonicalJson(vocabulary)).toString(16).padStart(14, "0")}`;
}

/**
 * The id of this build's frame vocabulary. Tabs share a socket only under the
 * same one (live-state's `SharedWebSocketOptions.dialect`), every `sub` /
 * `sub-batch` frame names it, and the runtime trusts a `sub`'s derivation
 * only under its own.
 */
export const PROTOCOL: string = protocolIdOf(VOCABULARY);
