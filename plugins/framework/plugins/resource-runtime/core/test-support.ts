/**
 * Shared test-support for the resource-runtime `bun:test` suites. Plain `.ts`
 * (NOT `.test.ts`) so `bun test` never collects it as a suite, and it imports no
 * `bun:test`. Extracts the harness/controllable/tick helpers that were duplicated
 * inside `runtime.test.ts` and adds the two capabilities the invariant suites
 * (`runtime-h5`, `runtime-scoped-routing`, `runtime-catchup`) need on top:
 *
 *   - `createHarness(opts?)` — `createResourceRuntime(opts)` wrapped with N fake
 *     sockets that record the FULL parsed frame (value / upserts / deletes /
 *     order / etag), not just `{seq,key,kind,version}`. Subsumes the old
 *     `harness()` + `feedHarness()` (a `readSet` option folds them into one) and
 *     the reval-only `revalHarness()` (subscribe takes an `etag`).
 *   - `makeClientView(keyOf?)` — a faithful client simulator that applies frames
 *     through the REAL WS version guard + keyed-delta merge, so a test can assert
 *     "the client converges to server truth" instead of eyeballing frame shapes.
 *   - `rng(seed)` — the mulberry32 PRNG (deduped from `keyed-diff.test.ts`).
 *
 * TWO block/release loaders, and the difference is load-bearing: `controllable()`
 * resolves its value at RELEASE time, `snapshotControllable()` captures it at
 * INVOCATION time. Only the latter can model a SELECT that has already run, so
 * only the latter can express a value read BEFORE a commit — any test about
 * stale-flight joins or freshness floors must use it. Reach for `controllable`
 * when the test is about ordering/coalescing and every flight should agree on the
 * same value.
 *
 * The client-side semantics mirrored here are load-bearing; see the cross-ref
 * comments on each (`notifications-client.ts` version guard, `keyed-delta-merge.ts`
 * merge). They are RE-implemented, never imported — resource-runtime must stay
 * acyclic and cannot depend on the live-state primitive.
 */

import {
  PROTOCOL,
  type Derivation,
  type DeriveSource,
} from "@plugins/packages/plugins/resource-protocol/core";
import {
  createResourceRuntime,
  type ResourceParams,
  type ResourceRuntimeOptions,
} from "./runtime";

// Next-macrotask yield: flushes all pending microtasks (the queued flush) AND any
// loader promises so the WS sends have landed in the log before we assert.
export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * A fully-parsed WS frame as recorded off a fake socket. `seq` is a monotonic
 * send-order counter shared across all sockets of one harness; `socket` is the
 * index of the socket it was sent to. Every other field is spread verbatim from
 * the parsed frame, so *presence* is faithful (`"etag" in frame` is true iff the
 * server actually attached one) — the reval tests depend on that.
 */
export interface RecordedFrame {
  seq: number;
  socket: number;
  kind: string;
  key?: string;
  id?: number;
  version?: number;
  value?: unknown;
  upserts?: [string, unknown][];
  deletes?: string[];
  order?: string[];
  etag?: string;
  /** Flight-co-produced commit watermark (Rule B′): full frames only. */
  watermark?: string;
  /** Mutation-ack attribution: feed-driven value frames and `ack` frames. */
  ackTx?: string[];
  /** Push timing (`update` / `delta` with a known change time): see `frameTiming`. */
  timing?: { changedAt: number; sentAt: number; deliverMs: number };
  reason?: string;
  /** `sub-error` on contract-mismatch / unknown-key: skew / same-build / unknown. */
  verdict?: string;
  params?: ResourceParams;
  /** Boot epoch stamped on sub-ack / up-to-date / up-to-date-batch frames. */
  epoch?: string;
  /** A DERIVED sub-ack's echo of the id of the derivation it answers (no `value` rides it). */
  derived?: { id: string };
  /** `up-to-date-batch` entries. */
  entries?: Array<{
    id?: number;
    key: string;
    params: ResourceParams;
    version: number;
  }>;
}

/** A `sub` frame's seeded derivation (the protocol's `Derivation`): its minted id and sources. */
export type DeriveFrame = Derivation;

/** One source of a `sub` frame's seeded derivation (the protocol's `DeriveSource`). */
export type DeriveSourceFrame = DeriveSource;

export interface Harness {
  runtime: ReturnType<typeof createResourceRuntime>;
  /** Every non-ping frame sent to any socket, in global send order. */
  frames: RecordedFrame[];
  /** Frames sent to one socket. */
  framesFor: (socketIdx: number) => RecordedFrame[];
  /** Send `op:sub` on a socket and await the next macrotask (sub-ack lands). */
  subscribe: (
    key: string,
    params?: ResourceParams,
    o?: {
      socket?: number;
      etag?: string;
      version?: number;
      epoch?: string;
      tabId?: string;
      /** Ask for standalone `{ kind: "ack" }` frames on this tuple. */
      acks?: boolean;
      /** The client's build graph (the frame's `build`); absent = a pre-protocol bundle. */
      build?: string;
      /** A seeded derivation: the new tuple as slices of tuples this socket holds. */
      derive?: DeriveFrame;
      /**
       * The frame vocabulary the tab names (the frame's `protocol`): default
       * this build's `PROTOCOL`, as live-state sends it; `null` omits it (a
       * bundle that predates the field).
       */
      protocol?: string | null;
    },
  ) => Promise<void>;
  /** Send `op:sub-batch` (one tab's whole-set replay) and await the next macrotask. */
  subscribeBatch: (
    entries: Array<{
      key: string;
      params?: ResourceParams;
      etag?: string;
      version?: number;
      acks?: boolean;
    }>,
    o?: {
      socket?: number;
      tabId?: string;
      epoch?: string;
      complete?: boolean;
      build?: string;
    },
  ) => Promise<void>;
  /** Send `op:sub-acks` (flip a held sub's ack request) and await the next macrotask. */
  subAcks: (
    key: string,
    params: ResourceParams,
    acks: boolean,
    o?: { socket?: number; tabId?: string },
  ) => Promise<void>;
  /** Send `op:unsub` on a socket and await the next macrotask. */
  unsub: (
    key: string,
    params?: ResourceParams,
    o?: { socket?: number; tabId?: string },
  ) => Promise<void>;
  /** Send `op:unsub-tab` (best-effort tab departure) and await the next macrotask. */
  unsubTab: (tabId: string, o?: { socket?: number }) => Promise<void>;
  /** Close a socket (runs the runtime's close handler, releasing its subs). */
  closeSocket: (socketIdx?: number) => void;
  /** Frames for `key`, excluding the initial sub-ack. Optionally scoped to one socket. */
  pushesFor: (key: string, socketIdx?: number) => RecordedFrame[];
  /**
   * The injected `readSet` hook's answer for `key` (`[]` when none was
   * injected) — so the routed fixture can refuse a read-set on a routed key,
   * which no router would ever read (`routed-fixture.ts`).
   */
  readSetOf: (key: string) => readonly string[];
  tick: typeof tick;
}

/**
 * A runtime under test plus `sockets` (default 1) fake `ServerWebSocket`s opened
 * via `notificationsWsHandler.open`. Records every frame each socket receives.
 * `opts` are the runtime's own `ResourceRuntimeOptions` (so a test injects
 * `readSet`, `shouldPersist`, `captureWatermark`, `persistSnapshot`, `onPush`, …)
 * plus the harness-only `sockets` count.
 */
export function createHarness(
  opts: ResourceRuntimeOptions & { sockets?: number } = {},
): Harness {
  const { sockets: socketCount = 1, ...runtimeOpts } = opts;
  const runtime = createResourceRuntime(runtimeOpts);
  const frames: RecordedFrame[] = [];
  let seq = 0;
  const handler = runtime.notificationsWsHandler as any;
  const wsList: any[] = [];
  for (let i = 0; i < socketCount; i++) {
    const socketIdx = i;
    // Fake ServerWebSocket: only `send` is exercised by the runtime's sendJson.
    const ws = {
      send(raw: string) {
        const msg = JSON.parse(raw) as Record<string, unknown> & {
          kind: string;
        };
        if (msg.kind === "ping") return; // ignore heartbeats
        // Spread verbatim so key presence (etag/value) is faithful for the reval
        // assertions; only seq/socket are synthesized.
        frames.push({ seq: seq++, socket: socketIdx, ...msg } as RecordedFrame);
      },
    };
    handler.open(ws);
    wsList.push(ws);
  }

  return {
    runtime,
    frames,
    framesFor: (socketIdx: number) =>
      frames.filter((f) => f.socket === socketIdx),
    async subscribe(key, params = {}, o = {}) {
      const ws = wsList[o.socket ?? 0];
      handler.message(
        ws,
        JSON.stringify({
          op: "sub",
          key,
          params,
          ...(o.etag !== undefined ? { etag: o.etag } : {}),
          ...(o.version !== undefined ? { version: o.version } : {}),
          ...(o.epoch !== undefined ? { epoch: o.epoch } : {}),
          ...(o.tabId !== undefined ? { tabId: o.tabId } : {}),
          ...(o.acks !== undefined ? { acks: o.acks } : {}),
          ...(o.build !== undefined ? { build: o.build } : {}),
          ...(o.derive !== undefined ? { derive: o.derive } : {}),
          ...(o.protocol !== null ? { protocol: o.protocol ?? PROTOCOL } : {}),
        }),
      );
      await tick(); // let the async sub-ack (initial load) complete
    },
    async subscribeBatch(entries, o = {}) {
      const ws = wsList[o.socket ?? 0];
      handler.message(
        ws,
        JSON.stringify({
          op: "sub-batch",
          tabId: o.tabId ?? "tab-test",
          protocol: PROTOCOL,
          ...(o.epoch !== undefined ? { epoch: o.epoch } : {}),
          ...(o.build !== undefined ? { build: o.build } : {}),
          complete: o.complete ?? true,
          entries: entries.map((e, i) => ({
            id: i + 1,
            key: e.key,
            params: e.params ?? {},
            ...(e.etag !== undefined ? { etag: e.etag } : {}),
            ...(e.version !== undefined ? { version: e.version } : {}),
            ...(e.acks !== undefined ? { acks: e.acks } : {}),
          })),
        }),
      );
      await tick(); // let detached full-path serves complete
    },
    async subAcks(key, params, acks, o = {}) {
      const ws = wsList[o.socket ?? 0];
      handler.message(
        ws,
        JSON.stringify({
          op: "sub-acks",
          key,
          params,
          acks,
          ...(o.tabId !== undefined ? { tabId: o.tabId } : {}),
        }),
      );
      await tick();
    },
    async unsub(key, params = {}, o = {}) {
      const ws = wsList[o.socket ?? 0];
      handler.message(
        ws,
        JSON.stringify({
          op: "unsub",
          key,
          params,
          ...(o.tabId !== undefined ? { tabId: o.tabId } : {}),
        }),
      );
      await tick();
    },
    async unsubTab(tabId, o = {}) {
      const ws = wsList[o.socket ?? 0];
      handler.message(ws, JSON.stringify({ op: "unsub-tab", tabId }));
      await tick();
    },
    closeSocket(socketIdx = 0) {
      handler.close(wsList[socketIdx], 1000, "test");
    },
    pushesFor(key, socketIdx) {
      return frames.filter(
        (f) =>
          f.key === key &&
          f.kind !== "sub-ack" &&
          (socketIdx === undefined || f.socket === socketIdx),
      );
    },
    readSetOf: (key) => runtimeOpts.readSet?.(key) ?? [],
    tick,
  };
}

/**
 * A loader whose completion the test controls. Initially open (so the sub-ack's
 * initial load resolves immediately); call `block()` to make the NEXT load park
 * until `release()`.
 *
 * Resolves the value at RELEASE time: every parked flight, whenever it started,
 * returns whatever `setValue` last wrote. That makes it the right tool for tests
 * about ORDERING and COALESCING (all flights agree on one value, so frame order is
 * the only variable) and the wrong tool for anything about freshness — it cannot
 * express "this flight's SELECT already ran, before the commit". Use
 * `snapshotControllable` for that.
 */
export function controllable<T>(initial: T) {
  let releaseFn: (() => void) | undefined;
  let blocker: Promise<void> = Promise.resolve();
  let value = initial;
  return {
    /** The current value the loader would return (for scoped-load test loaders). */
    get value(): T {
      return value;
    },
    loader: async (): Promise<T> => {
      await blocker;
      return value;
    },
    block() {
      blocker = new Promise<void>((res) => {
        releaseFn = res;
      });
    },
    release() {
      releaseFn?.();
    },
    setValue(v: T) {
      value = v;
    },
  };
}

/**
 * A `controllable` whose loader captures the value at INVOCATION time — a
 * faithful model of a SELECT that has already run. The captured value is what the
 * flight returns, no matter what `setValue` writes while it is parked.
 *
 * The contrast with `controllable` is the whole point, and it is why the
 * 2026-08-08 stale-flight bug survived a suite that staged its exact race:
 * `controllable` resolves at RELEASE time, so a flight started before a commit and
 * a flight started after it return the SAME value, and a test cannot tell a
 * pre-commit read from a post-commit one. **Any test about stale-flight joins,
 * `notBefore`, or version/value pairing MUST use this one** — with `controllable`
 * such a test asserts nothing, because the buggy and the correct runtime produce
 * identical frames.
 *
 * Same surface as `controllable` (`value`/`loader`/`block`/`release`/`setValue`)
 * plus `invocations`: how many times the loader body actually STARTED, which is
 * how a test tells a join (one invocation) from a supersession (two).
 *
 * See `research/2026-08-08-global-live-state-flight-freshness.md`.
 */
export function snapshotControllable<T>(initial: T) {
  let releaseFn: (() => void) | undefined;
  let blocker: Promise<void> = Promise.resolve();
  let value = initial;
  let invocations = 0;
  return {
    /** The value a loader invoked RIGHT NOW would capture. */
    get value(): T {
      return value;
    },
    /** How many times the loader body has been entered (joins do not count). */
    get invocations(): number {
      return invocations;
    },
    loader: async (): Promise<T> => {
      invocations++;
      // The read happens HERE — before the park, like a SELECT that has already
      // returned its rows while the caller is still waiting on something else.
      const captured = value;
      await blocker;
      return captured;
    },
    block() {
      blocker = new Promise<void>((res) => {
        releaseFn = res;
      });
    },
    release() {
      releaseFn?.();
    },
    setValue(v: T) {
      value = v;
    },
  };
}

// --- Client simulator -------------------------------------------------------

// Default row identity for keyed payloads (matches the tests' `{ id }` rows).
const defaultKeyOf = (row: unknown): string => (row as { id: string }).id;

/**
 * Faithful local mirror of `mergeKeyedDelta` in
 * `@plugins/primitives/plugins/live-state/web/keyed-delta-merge.ts`. Re-implemented
 * (not imported) because resource-runtime must stay acyclic and cannot depend on
 * the live-state primitive. Keep byte-behavior-identical with the source:
 *   - `order === undefined` ⇒ in-place upserts only (no add/delete/reorder, no drift).
 *   - `order` present ⇒ rebuild from the authoritative id list, reusing prior row
 *     references for ids the server didn't resend; any `order` id resolvable from
 *     neither `upsertMap` nor the cached base ⇒ `{ kind: "drift" }`.
 */
function mergeKeyedDeltaLocal(
  prevRows: readonly unknown[],
  upsertMap: ReadonlyMap<string, unknown>,
  order: readonly string[] | undefined,
  keyOf: (row: unknown) => string,
):
  | { kind: "merged"; rows: readonly unknown[] }
  | { kind: "drift"; missingIds: readonly string[] } {
  if (order === undefined) {
    return {
      kind: "merged",
      rows: prevRows.map((row) => upsertMap.get(keyOf(row)) ?? row),
    };
  }
  const existingById = new Map<string, unknown>();
  for (const row of prevRows) existingById.set(keyOf(row), row);
  const rows: unknown[] = [];
  const missingIds: string[] = [];
  for (const rowId of order) {
    const row = upsertMap.get(rowId) ?? existingById.get(rowId);
    if (row === undefined) {
      missingIds.push(rowId);
      continue;
    }
    rows.push(row);
  }
  if (missingIds.length > 0) return { kind: "drift", missingIds };
  return { kind: "merged", rows };
}

/**
 * A faithful single-subscription client simulator for one `(key, params)`. Applies
 * frames through the REAL WS version guard + keyed-delta merge so a test can assert
 * "the client converged to server truth", not just a frame shape.
 *
 * Version guard mirrors `notifications-client.ts` `handleServerMessage` (~L862):
 * APPLY a frame iff `frame.version > version`. Baseline is `-1` ("nothing applied
 * yet"), so the very first frame is accepted — a first sub-ack reports the fresh
 * version (≥ 1) its tuple's tracking span opened with (`registerSubOnSocket`).
 */
export interface ClientView {
  readonly value: unknown;
  readonly version: number;
  /**
   * The boot epoch `version` belongs to — stamped from the last epoch-carrying WS
   * frame (`sub-ack`/`up-to-date`) that adopted a version. `undefined` until the
   * first such frame. Labels `version` so a cross-boot HTTP body isn't mis-compared.
   */
  readonly epoch: string | undefined;
  /** How many deltas arrived with no resolvable base (the real client resubs). */
  readonly driftResubs: number;
  /** Set by an `invalidate` frame; a test converges it via `applyHttpRefetch`. */
  readonly stale: boolean;
  /**
   * Mirror of live-state's derived sub: the slice this view's `sub` asked to
   * be seeded with, and the id of the derivation it sent. A DERIVED `sub-ack`
   * echoing exactly that id adopts the slice as the value; one echoing
   * another is dropped (it answers someone else's request); a value-carrying
   * `sub-ack` (the fallback) clears it.
   */
  expectDerived(value: readonly unknown[], derive: { id: string }): void;
  apply(frame: RecordedFrame): void;
  applyAll(frames: readonly RecordedFrame[]): void;
  /**
   * Adopt a refetch (HTTP GET) result — the invalidate-mode convergence path.
   * Hand-mirrors `fetchOverHttp`'s epoch-aware guard (Fix B). An epoch-less body
   * (pre-upgrade server) keeps today's strict-`<` behavior; when the body carries
   * an `epoch` and the view holds an entry epoch, the guard matrix applies:
   *   1. same boot (`body.epoch === entry.epoch`) → strict-`<` (equal-version accept);
   *   2. entry stale-boot (`body.epoch === serverEpoch`) → ADOPT unconditionally;
   *   3. body stale-boot (`entry.epoch === serverEpoch`) → DROP;
   *   4. no arbiter (neither matches serverEpoch) → ADOPT (WS-down fallback window).
   * The view's "known server epoch" mirrors the WS channel's current identity: the
   * last epoch seen on any `sub-ack`/`up-to-date` frame.
   */
  applyHttpRefetch(res: {
    value: unknown;
    version: number;
    epoch?: string;
  }): void;
}

export function makeClientView(
  keyOf: (row: unknown) => string = defaultKeyOf,
): ClientView {
  let version = -1;
  let value: unknown = undefined;
  let driftResubs = 0;
  let stale = false;
  // The boot `version` belongs to. Stamped from epoch-carrying WS frames only
  // (`sub-ack`/`up-to-date`); `update`/`delta`/`invalidate` leave it unchanged.
  let entryEpoch: string | undefined = undefined;
  // The WS channel's current server identity — the last epoch seen on any frame.
  let serverEpoch: string | undefined = undefined;
  // The derivation this view's `sub` asked for, and the slice it adopts if the
  // answer is that derivation's (see `expectDerived`).
  let derivation: { value: readonly unknown[]; id: string } | undefined;

  return {
    get value() {
      return value;
    },
    get version() {
      return version;
    },
    get epoch() {
      return entryEpoch;
    },
    get driftResubs() {
      return driftResubs;
    },
    get stale() {
      return stale;
    },
    expectDerived(slice, derive): void {
      derivation = { value: slice, id: derive.id };
    },
    apply(frame: RecordedFrame): void {
      // Any epoch-carrying frame refreshes the channel's known server identity,
      // even if its version fails the guard below (an old-boot replay still tells
      // us which boot the socket is now talking to).
      if (frame.epoch !== undefined) serverEpoch = frame.epoch;
      if (frame.version === undefined) return; // sub-error / ping — no version
      // WS version guard: drop anything not strictly newer than what we hold.
      if (frame.version <= version) return;
      if (frame.kind === "sub-ack" && frame.derived !== undefined) {
        // An answer to someone else's derivation: nothing to adopt, and no
        // version claim about a value this view holds.
        if (derivation === undefined || derivation.id !== frame.derived.id) {
          return;
        }
        version = frame.version;
        value = [...derivation.value];
        derivation = undefined;
        if (frame.epoch !== undefined) entryEpoch = frame.epoch;
        return;
      }
      if (frame.kind === "sub-ack") derivation = undefined;
      if (frame.kind === "sub-ack" || frame.kind === "update") {
        version = frame.version;
        value = frame.value;
        // `update` carries no epoch → leaves `entryEpoch` unchanged; `sub-ack` does.
        if (frame.epoch !== undefined) entryEpoch = frame.epoch;
        return;
      }
      if (frame.kind === "up-to-date") {
        // Conditional-revalidation hit: adopt the version, keep the cached value.
        version = frame.version;
        if (frame.epoch !== undefined) entryEpoch = frame.epoch;
        return;
      }
      if (frame.kind === "invalidate") {
        // The real client adopts the version (guard) then refetches over HTTP.
        version = frame.version;
        stale = true;
        return;
      }
      if (frame.kind === "delta") {
        const upsertMap = new Map<string, unknown>();
        for (const [id, row] of frame.upserts ?? []) upsertMap.set(id, row);
        const prevRows = Array.isArray(value) ? (value as unknown[]) : [];
        const result = mergeKeyedDeltaLocal(
          prevRows,
          upsertMap,
          frame.order,
          keyOf,
        );
        if (result.kind === "drift") {
          // Base drift: the real client discards the delta and resubs for a fresh
          // full base. We record it and leave value/version UNCHANGED, so drift is
          // a detectable non-converged state until a later full frame arrives.
          driftResubs++;
          return;
        }
        version = frame.version;
        value = result.rows;
        return;
      }
    },
    applyAll(fs: readonly RecordedFrame[]): void {
      for (const f of fs) this.apply(f);
    },
    applyHttpRefetch(res: {
      value: unknown;
      version: number;
      epoch?: string;
    }): void {
      const bodyEpoch = res.epoch;
      const adopt = (): void => {
        // Cross-epoch adopt: `version` is NOT monotonic here — an old-boot number is
        // meaningless against a new-boot body — so we take the body's version wholesale.
        version = res.version;
        value = res.value;
        if (bodyEpoch !== undefined) entryEpoch = bodyEpoch;
        stale = false;
      };
      // Epoch-less body (pre-upgrade server) or no known entry epoch → today's
      // behavior byte-for-byte: strict-`<` guard on version.
      if (bodyEpoch === undefined || entryEpoch === undefined) {
        if (res.version < version) return; // strict-< HTTP guard
        version = res.version;
        value = res.value;
        if (bodyEpoch !== undefined) entryEpoch = bodyEpoch;
        stale = false;
        return;
      }
      // Case 1 — same boot: keep strict-`<` (preserves the equal-version accept).
      if (bodyEpoch === entryEpoch) {
        if (res.version < version) return;
        version = res.version;
        value = res.value;
        stale = false;
        return;
      }
      // Epochs differ.
      // Case 2 — entry is stale-boot, body is the WS's current server identity: ADOPT.
      if (bodyEpoch === serverEpoch) return adopt();
      // Case 3 — body is stale-boot, entry is the current server identity: DROP.
      if (entryEpoch === serverEpoch) return;
      // Case 4 — no arbiter (serverEpoch matches neither / undefined): ADOPT.
      adopt();
    },
  };
}

/**
 * Deterministic PRNG (mulberry32) so a fuzz failure is reproducible from its
 * seed — `Math.random()` would make a red run impossible to replay. Single-sourced
 * here and imported by `keyed-diff.test.ts`.
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
