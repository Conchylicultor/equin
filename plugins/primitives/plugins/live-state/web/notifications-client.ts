import type {
  Query,
  QueryCacheNotifyEvent,
  QueryClient,
} from "@tanstack/react-query";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import {
  SharedWebSocket,
  type TransportSocket,
  subscribeWsStatus,
  subscribeNetDiag,
  type SharedWebSocketOptions,
  type WsStatus,
  type NetDiagEvent,
} from "@plugins/primitives/plugins/networking/web";
import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { clientLog } from "@plugins/primitives/plugins/log-channels/web";
import { getTabId } from "@plugins/primitives/plugins/scope/plugins/tab-id/web";
import type { ResourceDescriptor, ResourceOrigin } from "../core";
import { mergeKeyedDelta } from "./keyed-delta-merge";
import { applyValuePatch } from "@plugins/packages/plugins/value-patch/core";
import { rootWatermarks, type WatermarkRegistry } from "./watermark-registry";
import { rootTxAcks, type TxAckRegistry } from "./tx-ack-registry";
import { httpStaleDropReportSink } from "./stale-drop-reporter";
import {
  clientLatencySink,
  splitPhases,
} from "@plugins/primitives/plugins/perfs/plugins/latency-signal/core";
import {
  BUILD_GRAPH_HEADER,
  DERIVE_MAX_SOURCES,
  DEV_BUILD,
  parseResourceBytesHeaders,
  PROTOCOL,
  parseResourceHttpErrorBody,
  type ClientFrame,
  type ContractVerdict,
  type Derivation,
  type DeriveSource,
  type ExactClientFrame,
  type ServerFrame,
  type SubErrorReason,
} from "@plugins/packages/plugins/resource-protocol/core";
import { markResourceContractMismatch } from "./resource-contract-store";
import { unansweredSubReportSink } from "./unanswered-sub-reporter";
import { toResourceError } from "./resource-error";
import {
  resourceErrorReportSink,
  type FailingResource,
} from "./resource-error-reporter";
import {
  ResourceHttpError,
  ResourceStaleReadError,
} from "./resource-http-errors";

// Re-exported for the transport's own importers (tests, the barrel): the classes
// live in a dependency-free module so `resource-error.ts` can classify them
// without importing this whole client.
export { ResourceHttpError, ResourceStaleReadError };

/**
 * How the client reads one resource's answers: the payload `schema` every
 * value is parsed through, the `refusals` it may be refused with (absent ⇒
 * none), and whether it is a `bytes` value (an `ArrayBuffer` read as
 * `application/octet-stream`, its envelope in response headers), and whether
 * its changes arrive as `patch` frames (`patches`). Its
 * declaration's — a `ResourceDescriptor` is one — so a read and the server it
 * reads from are checked against ONE declaration.
 */
export type ResourceRead<T> = Pick<
  ResourceDescriptor<T>,
  "schema" | "refusals" | "bytes" | "patches"
>;

/**
 * The build graph this tab's bundle was built from — sent on every `sub` /
 * `sub-batch` frame and every HTTP read, so the server can tell a tab running
 * an older bundle (skew — a reload fixes it) from a real contract bug. Read at
 * call time (tests stub it); `"dev"` where the build injected none.
 */
function clientBuild(): string {
  return import.meta.env.VITE_BUILD_GRAPH ?? DEV_BUILD;
}

/**
 * Record a server refusal that means "this bundle does not speak the
 * resource's contract" into the page-global store the Reload advice reads.
 * `loader-failed` / `unauthorized` are the server's own failures, not skew.
 */
function noteContractRefusal(
  key: string,
  reason: SubErrorReason | undefined,
  verdict: ContractVerdict | undefined,
): void {
  if (reason !== "contract-mismatch" && reason !== "unknown-key") return;
  markResourceContractMismatch({
    key,
    reason,
    ...(verdict !== undefined ? { verdict } : {}),
  });
}

/**
 * A refusal the client must not retry: the same params from the same bundle
 * are refused the same way every time, so a retry is one more request for
 * nothing. `useResource`'s retry policy reads it.
 */
export function isTerminalResourceError(err: unknown): boolean {
  return (
    err instanceof ResourceHttpError &&
    (err.reason === "contract-mismatch" ||
      err.reason === "unknown-key" ||
      err.reason === "unserved" ||
      err.reason === "refused")
  );
}

/**
 * The identity this document's client holds its subscriptions under — minted
 * once per JavaScript realm, never read from storage.
 *
 * The server keys sub ownership by it (`sub` / `unsub` / `unsub-tab` and the
 * `sub-batch complete:true` reconciliation all release by it), so it must name
 * exactly ONE client. The browser-tab id (`getTabId()`) does not: it lives in
 * `sessionStorage`, which a same-origin iframe of the app (a prototype's Real
 * app frame, any `?embed=` document) shares with its host. Keyed by it, the
 * frame's `pagehide` `unsub-tab` released every sub the HOST held — the server
 * stopped pushing while the host still believed it was subscribed, and a
 * conversation's transcript froze until the sub happened to cycle.
 */
const REALM_HOLDER_ID = crypto.randomUUID();

/**
 * The shared socket's options: its dialect is the frame vocabulary's id
 * (`PROTOCOL`, `packages/resource-protocol`). The server answers one tab's
 * request with frames every tab on the socket receives, and a frame
 * vocabulary grows (a derived `sub-ack` carries no value: a bundle that
 * predates it would parse `undefined` as the tuple's value and adopt its
 * version, wedging its own read). So a tab shares its socket only with tabs
 * that read frames alike — an older bundle left open across a deploy that
 * changed the vocabulary keeps a socket of its own and never sees a frame it
 * cannot read, while a deploy that did not change it keeps every tab on one.
 */
const SOCKET_OPTIONS: SharedWebSocketOptions = { dialect: PROTOCOL };

/**
 * A frame this client sends — the protocol's, and only the protocol's: a field
 * its `op` does not declare is a type error however the frame was built
 * (`ExactClientFrame`), so the wire cannot grow without moving `PROTOCOL`.
 */
const wire = <F extends ClientFrame>(frame: ExactClientFrame<F>): string =>
  JSON.stringify(frame);

// Per-hop persistent tracing for the live-state update pipeline (Layer 1). All
// lines route to the `live-state` log channel over plain HTTP via clientLog —
// decoupled from the notifications WS, so traces still flush even when the WS
// pipeline this watches is wedged. Each line is stamped `[tabId/holder]`: the
// browser tab, then the client inside it — a host document and its embedded
// frames share the first and never the second.
//
// Always-on lines are low-volume (transitions and silent-drop anomalies — the
// exact failure signatures). The per-frame successful apply is high-volume and
// gated behind a dev-only localStorage flag (see verboseTraceOn).
function trace(line: string): void {
  clientLog(
    "live-state",
    `[${getTabId()}/${REALM_HOLDER_ID.slice(0, 8)}] ${line}`,
  );
}

// Dev-only verbose toggle for the high-volume per-apply trace, set from the
// console: set the key `s:live-state.verbose-trace:` to {"v":true,"ts":<now>}
// (no config_v2 server plumbing for a debug switch).
const verboseTraceFlag = defineStore({
  owner: "live-state.verbose-trace",
  label: "Debug flags",
  area: "local",
  cap: "1 KB",
  ttl: Infinity,
  whenFull: "refuse",
  schema: z.boolean(),
  // The flag used to be the raw key `liveState.verboseTrace` = "1".
  legacy: {
    match: (key) => key === "liveState.verboseTrace",
    adopt: (_key, raw) =>
      raw === "1" ? { id: "", value: true, ts: Date.now() } : null,
  },
});

function verboseTraceOn(): boolean {
  const read = verboseTraceFlag.read();
  return read.kind === "value" && read.value;
}

// Drives the TanStack Query cache off server resource notifications. Uses
// SharedWebSocket, which transparently shares the connection across all tabs
// of the origin (the real socket lives in a SharedWorker). On every new server
// connection (backend restart, network drop, a tab restored from the bfcache),
// `replaySubs` resends every active subscription — the server's sub state is per-connection and this client is
// the source of truth for what the UI wants to observe.
//
// The client maintains one socket per *resource origin*: the per-worktree
// backend (default) at /ws/notifications, and the central runtime at
// /ws/central-notifications. Subscriptions route to the right socket based on
// the descriptor's `origin` field.

const WS_URLS = {
  worktree: "/ws/notifications",
  central: "/ws/central-notifications",
} as const;

// After the last observer of a (key,params) leaves, keep its WS subscription
// alive briefly so a transient unmount→remount (list virtualization, streaming
// rows that filter in/out) reuses the live sub instead of churning a
// unsub→resub round-trip. Mirrors TanStack Query's gcTime, which keeps the
// cache entry alive on the same principle (use-resource.ts relies on that for
// the value; this aligns the WS sub lifetime with it). This is a one-shot
// deferred-cleanup timer, NOT a polling loop — it checks nothing on a schedule.
const SUB_KEEPALIVE_MS = 30_000;

type SocketKind = keyof typeof WS_URLS;

export type ChannelStatuses = {
  worktree: WsStatus;
  central: WsStatus;
  /**
   * Per channel: how long the server's running live-state flush pass had been
   * open at its latest heartbeat ping (0 when idle, and 0 until the first ping
   * of the current connection). A flush that never settles freezes every push
   * behind it while the socket stays open and quiet, so this is the only sign
   * of it the tab gets — the health report's Connection row reads it.
   * research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md
   */
  serverFlushOpenMs: Record<LiveStateSocketKind, number>;
};

/** Live-state pipeline socket kind, as classified from a ws-status-bus url. */
export type LiveStateSocketKind = SocketKind;

/**
 * Classify a ws-status-bus url as a live-state pipeline socket, or return null
 * if it belongs to some other socket (logs, terminal, build) that merely shares
 * the global status bus. This is the single source of truth for "which sockets
 * are the live-state pipeline" — both this client's own bus filter and the
 * health watchdog gate on it, so an unrelated socket's downtime is never
 * mis-attributed to live-state.
 */
export function liveStateSocketKind(url: string): LiveStateSocketKind | null {
  for (const kind of Object.keys(WS_URLS) as SocketKind[]) {
    if (url === WS_URLS[kind]) return kind;
  }
  return null;
}

/**
 * The URL the live-state pipeline over `transport` opens its `kind` socket at —
 * the url the ws-status bus reports that socket under. For a client that must
 * react to ITS transport's live-state socket reopening (a content-doc provider
 * resuming an interrupted flush), never to another transport's:
 * `liveStateSocketKind` knows only the page's own.
 */
export function liveStateSocketUrl(
  transport: { socketUrl(path: string): string },
  kind: LiveStateSocketKind,
): string {
  return transport.socketUrl(WS_URLS[kind]);
}

function socketKindFor(origin: ResourceOrigin | undefined): SocketKind {
  return origin === "central" ? "central" : "worktree";
}

type ResourceParams = Record<string, string>;

export interface ResourceKey {
  key: string;
  params?: ResourceParams;
}

/**
 * A fresh tuple seeded from rows this tab already holds (a paged read's split
 * or merge): its value is, in order, a slice of each `from` tuple's value —
 * the rows after the row `after` (exclusive; `null` = from its first row)
 * through the row `until` (inclusive; `null` = through its last), by row id
 * (the descriptor's `keyed.keyOf`). The caller states that this IS the new
 * tuple's value — its params name exactly the range those slices cover — and
 * the server checks what it can (each source a range of the same query,
 * quiescent at the version sliced, a source sliced through its end not full,
 * the rows fit the new window): agreed, the tuple loads nothing; refused, it
 * loads as any sub does. At most {@link DERIVE_MAX_SOURCES} sources (a split
 * reads one, a merge two) — more seed nothing.
 *
 * Sliced as each source's value stands when the sub is sent, and only while
 * that is the value `appliedSeq` was read beside (a `ResourceTupleResult`'s):
 * a source applied since — or held through an HTTP read, or not held — seeds
 * nothing, and the sub loads.
 */
export interface ResourceDerivation<P extends ResourceParams = ResourceParams> {
  from: readonly ResourceSlice<P>[];
}

/** One source of a {@link ResourceDerivation}. */
export interface ResourceSlice<P extends ResourceParams = ResourceParams> {
  params: P;
  /** The source's `appliedSeq` when the slice was decided. */
  appliedSeq: number;
  after: string | null;
  until: string | null;
}

/**
 * A `sub` frame's `derive` (the protocol's `Derivation`): its sources, and the
 * id this client minted for it — the one thing a derived ack echoes, so
 * matching an answer to its question never depends on how the server spells
 * the sources back.
 */
type DerivationFrame = Derivation;

// Every frame the server sends, as the protocol declares it (`ServerFrame`,
// `packages/resource-protocol` — each field's meaning is documented there).
// The shared socket fans every frame out to every tab on it, so this tab reads
// frames answering other tabs' requests too: every kind below is gated on a
// live local sub before it touches the cache (`handleServerMessage`).
type ServerMsg = ServerFrame;
/** The co-produced push timing an update / delta frame may carry. */
type FrameTiming = NonNullable<
  Extract<ServerMsg, { kind: "update" | "patch" | "delta" }>["timing"]
>;

function paramsKey(params: ResourceParams | undefined): string {
  if (!params) return "{}";
  const keys = Object.keys(params).sort();
  const obj: ResourceParams = {};
  for (const k of keys) obj[k] = params[k]!;
  return JSON.stringify(obj);
}

/**
 * The `(key, params)` a live-state query key names — the inverse of
 * `queryKeyFor` — or null for a key of another shape.
 */
function resourceTupleOf(
  queryKey: readonly unknown[],
): { key: string; params: ResourceParams } | null {
  const [key, params, ...rest] = queryKey;
  if (typeof key !== "string" || rest.length > 0) return null;
  if (params === undefined) return { key, params: {} };
  if (typeof params !== "object" || params === null) return null;
  return { key, params: params as ResourceParams };
}

export function queryKeyFor(
  key: string,
  params: ResourceParams | undefined,
): unknown[] {
  const p = params && Object.keys(params).length > 0 ? params : undefined;
  return p ? [key, p] : [key];
}

interface ActiveSub {
  refcount: number;
  key: string;
  params: ResourceParams;
  /**
   * The request this sub's last `sub` / replay entry made on an OPEN socket —
   * its frame `id`, and `since` (`Date.now()` when it went out) — while no
   * answer to THAT request has landed; undefined otherwise. Read by the
   * unanswered-sub deadline (see `armUnansweredCheck`). Cleared only by a frame
   * echoing this tab's `tabId` and this `id` (`noteAnswered`): another tab's
   * answer for the same tuple on the shared socket is not this request's, and
   * an answer the version guard then drops was still answered.
   */
  awaiting?: { id: number; since: number };
  /**
   * Highest server version (state-change count) this sub has applied. `-1` =
   * nothing applied yet — the baseline a fresh or replayed sub starts from, so
   * the first sub-ack always passes the `<=` staleness guard. The server bumps
   * the version on a real notify, and once more when a tuple's subscription
   * span opens (its first subscriber after none) — never on a resubscribe of a
   * tuple it still holds, so a same-socket replay reports the version it
   * already had. Both `lastAckVersion` and `liveFrameSeq` below are derived
   * from this stream and are what the missed-update watchdog
   * (`probeMissedUpdates`) actually reads.
   */
  version: number;
  /**
   * Version delivered by the most recent `sub-ack` (server truth at the moment
   * of (re)subscribe). Distinct from `version`, which a live `update` frame also
   * advances — `lastAckVersion` moves *only* on a sub-ack. `probeMissedUpdates`
   * compares this (not `version`) against the pre-resync baseline so a live
   * frame arriving during the settle window can't masquerade as a missed one.
   * `-1` = no ack applied since the last (re)subscribe.
   */
  lastAckVersion: number;
  /**
   * Monotonic count of live, server-initiated frames applied — `update`/`delta`/
   * `invalidate`, never `sub-ack`. Never reset. `probeMissedUpdates` diffs it
   * across the probe: if it advanced, a live frame landed during the window, so
   * any version gap is healthy delivery, not a miss.
   */
  liveFrameSeq: number;
  socket: SocketKind;
  /** ms epoch of the last applyUpdate/applyDelta write for this sub (0 = never). */
  lastAppliedAt: number;
  /**
   * When this sub's value was last written (WS or HTTP), on the client-wide
   * apply sequence (`NotificationsClient.appliedSeq`): of two tuples, the one
   * with the higher sequence holds the more recently applied value. `0` =
   * nothing applied on this sub yet.
   */
  appliedSeq: number;
  /**
   * The cached value is the one this socket's frames built — a `sub-ack`,
   * `update`, `delta` or derived ack applied in order — so it IS the server's
   * snapshot of the tuple at `version`, and a new tuple may be derived from a
   * slice of it. An HTTP body (read apart from that snapshot) clears it.
   */
  socketValue: boolean;
  /**
   * A PATCHED read's base (`ResourceDescriptor.patches`): the value exactly as
   * the server sent it — before the schema parse — of the last `sub-ack`,
   * `update` or `patch` applied, at `version`. A `patch` frame applies to it
   * (the parsed cache value may differ from the wire: a coerced date). An
   * HTTP body and a forced resub clear it; undefined on every other read.
   */
  wire?: { value: unknown };
  /**
   * The derivation this sub's in-flight `sub` asked for (`observe`'s
   * `derive`): the rows to adopt, and the id a derived `sub-ack` must echo
   * for them to be this tab's. Cleared by any answer, and by every
   * resubscribe that asks for a full value (replay, forced resub).
   */
  derivation?: { rows: readonly unknown[]; id: string };
  /**
   * Last-known conditional-revalidation ETag (content signature) for this
   * (key, params), stored from any `sub-ack`/`update` frame that carried one.
   * Sent back on the next `sub` so the server can answer `up-to-date` (keep the
   * cached value) instead of re-running the loader. Preserved across reconnect
   * (`replaySubs`) — that is what makes the post-restart resubscribe cheap.
   * Undefined for a resource that has not opted into revalidation, or before the
   * first value arrives. Cleared when the cached base is lost (a delta with no
   * base / drift) so recovery forces a full reload, never a stale `up-to-date`.
   */
  etag?: string;
  /**
   * Which server boot `version` belongs to — learned from any epoch-carrying ack
   * frame (`sub-ack` / `up-to-date`). Server versions are per-boot in-memory
   * counters, incomparable across boots; `epoch` labels the boot so
   * `fetchOverHttp`'s guard can tell a same-boot stale read (drop) from a
   * stale-boot cache that a live response should replace (adopt). Undefined until
   * the first ack, or on a pre-epoch server. `update`/`delta`/`invalidate` frames
   * leave it unchanged (they ride the same boot's stream).
   */
  epoch?: string;
}

/** One entry per active sub returned by `debugSnapshot()` (Layer 2 inspector). */
export interface DebugSub {
  key: string;
  paramsKey: string;
  version: number;
  lastAppliedAt: number;
  refcount: number;
  socket: SocketKind;
}

/** Push-based introspection payload for the live-state-health inspector. */
export interface DebugSnapshot {
  subs: DebugSub[];
  sockets: ChannelStatuses;
  transport: { worktree: TransportInfo; central: TransportInfo };
}

/** One socket's shared-transport view (null fields: channel never opened / not attached yet). */
export interface TransportInfo {
  /** Tabs attached to the shared socket, as last reported by its worker. */
  attachedTabs: number | null;
  /** The server connection this tab is bound to, while open. */
  connection: string | null;
}

/** One genuinely-missed sub returned by `probeMissedUpdates()` (watchdog). */
export interface MissedFrame {
  key: string;
  params: ResourceParams;
  socket: SocketKind;
  /** Version this tab had applied before the probe's forced resync. */
  prevVersion: number;
  /** Higher version the resync sub-ack revealed — the frames we missed. */
  ackVersion: number;
}

interface SocketChannel {
  ws: TransportSocket;
  /** (key, paramsKey) -> subscription state for subs routed to this socket. */
  subs: Map<string, ActiveSub>;
  /**
   * (key, paramsKey) -> pending deferred-teardown timer. An entry lives here
   * only while a refcount-0 sub is inside its SUB_KEEPALIVE_MS gc window: a
   * resurrecting observe() cancels it, otherwise the timer fires and tears the
   * sub down. Keyed by the same `${key}\0${paramsKey}` id as `subs`.
   */
  pendingTeardown: Map<string, ReturnType<typeof setTimeout>>;
  /**
   * (key, paramsKey) -> how many of this tab's readers want standalone ack
   * frames for the tuple (`requestAcks`). Kept apart from `subs` so the order
   * of `observe()` and `requestAcks()` does not matter: every `sub` frame and
   * replay entry restates `acks: true` while the count is positive, and a
   * 0↔1 transition on a live sub sends `op: "sub-acks"`. Keyed by the same
   * `${key}\0${paramsKey}` id as `subs`.
   */
  ackInterest: Map<string, number>;
  /**
   * The server's boot identity, learned from any ack frame carrying `epoch`
   * (`sub-ack` / `up-to-date` / `up-to-date-batch`). Echoed with each sub's
   * version in the replay batch so a same-boot server can short-circuit
   * already-current subs to `up-to-date` — no loader, no read-admission slot.
   * A restart mints a new epoch, so a post-restart replay's stale echo simply
   * takes the full path and re-learns. Undefined until the first ack.
   */
  serverEpoch?: string;
  /**
   * How many times this channel's socket has opened. A replay on a NEW socket
   * re-baselines by design: the server released the old socket's tuples, so
   * each opens a fresh tracking span at a fresh, higher version whether or not
   * anything changed. `probeMissedUpdates` reads it to tell that apart from a
   * frame the live socket really missed.
   */
  opens: number;
  /** The one armed unanswered-sub deadline for this channel (see `armUnansweredCheck`). */
  unansweredTimer?: ReturnType<typeof setTimeout>;
}

/**
 * How long a sub sent on an open socket may go unanswered. The server
 * registers a sub synchronously on receipt and always answers it, so past this
 * the frame or its answer was lost between this tab and the server while the
 * transport still reads "open" — reported (`unansweredSubReportSink`), never
 * silently retried.
 */
export const UNANSWERED_SUB_MS = 15_000;

/** One live-state pipeline's causal-floor registries. */
export interface LiveRegistries {
  watermarks: WatermarkRegistry;
  txAcks: TxAckRegistry;
}

/** The page's own pipeline's registries. */
export const rootLiveRegistries: LiveRegistries = {
  watermarks: rootWatermarks,
  txAcks: rootTxAcks,
};

export class NotificationsClient {
  // Lazily-populated: the worktree channel is opened eagerly in the constructor,
  // but the central channel is created only when a central-origin resource is
  // first observed (see `channelFor`). An app with no central resources (a
  // self-contained release with `auth` excluded) therefore never opens
  // /ws/central-notifications — a release ships no central runtime, so that
  // socket would otherwise 404 and reconnect forever, pinning the overall status.
  private channels: Partial<Record<SocketKind, SocketChannel>> = {};
  private nextMsgId = 1;
  /**
   * key → how its answers are read (schema + declared refusals). Registered on
   * every observe() call from useResource. Used in applyUpdate to parse WS
   * payloads before they hit the cache, and by the HTTP reads a sub-error or
   * the cold-start prime starts. Last-write-wins is fine: the same key always
   * pairs to the same declaration (resources are singletons defined at module
   * scope).
   */
  private reads = new Map<string, ResourceRead<unknown>>();
  /**
   * key → row-identity fn for keyed resources. Registered alongside the schema
   * in observe(). Used by applyDelta to key prior cache rows when merging a
   * delta. Absent for non-keyed resources.
   */
  private keyedKeyOf = new Map<string, (row: unknown) => string>();
  /**
   * `${key}\0${paramsKey}` → count of consecutive HTTP stale drops since the last
   * successful apply. Incremented on every `fetchOverHttp` drop (both same-epoch
   * strict-`<` and cross-boot stale-epoch), emitted with the running count to the
   * stale-drop report sink, and reset in `markApplied` (WS or HTTP). A sustained
   * never-applied run is the wedge signature the reports consumer thresholds on.
   */
  private staleDropCounts = new Map<string, number>();
  /**
   * The client-wide apply sequence: bumped on every value written to a sub's
   * cache (`markApplied`), so each sub's `appliedSeq` orders its value against
   * every other sub's — a millisecond timestamp ties within one frame burst.
   */
  private applySeq = 0;
  private channelStatuses = new Map<string, WsStatus>();
  /** Latest heartbeat `flushOpenMs` per channel — see `ChannelStatuses`. Reset
   *  to 0 whenever the channel's socket status changes, so a stall reported by
   *  a server that has since restarted never outlives its connection. */
  private serverFlushOpenMs: Record<SocketKind, number> = {
    worktree: 0,
    central: 0,
  };
  private statusListeners = new Set<(s: WsStatus) => void>();
  private channelStatusListeners = new Set<(s: ChannelStatuses) => void>();
  /** Fired on any sub/version/socket/transport change for the Layer-2 inspector. */
  private debugListeners = new Set<() => void>();
  private unsubscribeFromBus: () => void;
  /** Net-diag bus unsubscriber, captured so `destroy()` can release it (a test
   *  constructs many clients; the module-level bus would otherwise leak). */
  private unsubscribeFromNetDiag: () => void;
  /** Socket factory (injection seam): defaults to a real `SharedWebSocket`; a
   *  test wires one built on fake transports, a scoped pipeline its transport's. */
  private makeSocket: (url: string) => TransportSocket;
  /** The URL each socket kind opens at — the identity the ws-status bus reports
   *  it under, so this client reads ITS sockets' status and never another
   *  pipeline's (see `socketKindOf`). */
  private socketUrls: Record<SocketKind, string>;
  /** This pipeline's causal-floor registries (`rootWatermarks` / `rootTxAcks`
   *  for the page's own pipeline). Read by the optimistic hook through
   *  `useLiveRegistries`. */
  readonly registries: LiveRegistries;
  /** `fetch` implementation (injection seam): defaults to the global `fetch`; a
   *  test wires a scripted one to drive `fetchOverHttp` deterministically. Used
   *  for BOTH the conditional GET and the defensive refetch. Typed as the call
   *  signature only (not `typeof fetch`, which also carries the `preconnect`
   *  static a plain closure lacks). */
  private fetchImpl: (
    ...args: Parameters<typeof fetch>
  ) => ReturnType<typeof fetch>;
  /**
   * The holder id stamped on every sub/unsub frame so the server can track
   * which client holds which sub (the per-holder bookkeeping behind `unsub-tab`
   * and the `sub-batch complete:true` reconciliation) — `REALM_HOLDER_ID`, one
   * per document, never a storage-backed id (see its doc for the incident).
   * The wire field keeps its historical name `tabId`. Injection seam for tests
   * that run two "tabs" in one jsdom realm, which would otherwise share it.
   */
  private tabId: string;
  /**
   * Whether this client's read telemetry is reported — the transport's
   * `telemetry`: a scope set to drop it emits nothing to the page-wide sinks
   * (`resourceErrorReportSink`, `httpStaleDropReportSink`, the update sample
   * on `clientLatencySink`). The failing set itself (`useFailingResources`)
   * is the scope's own UI state, kept regardless. Read by the readers built
   * on this client's pipeline (the optimistic overlay's own samples).
   */
  readonly telemetry: boolean;
  /**
   * `${key}\0${paramsKey}` → the live read currently failing on that tuple (its
   * query holds an error). Kept from the query cache's own events — never from
   * the hooks — so N observers of one tuple are one entry, one report, one
   * retry. Read by the health report (`useFailingResources`) and by the
   * event-driven retry (`retryFailing`).
   */
  private failing = new Map<string, FailingResource>();
  private failingSnapshot: readonly FailingResource[] = [];
  private failingListeners = new Set<() => void>();
  private unsubscribeFromQueryCache: () => void;
  /**
   * Wall-clock epoch ms of the last instant this page was hidden (`null`: not
   * since the client was built). Stamped on every `visibilitychange` — going
   * hidden and coming back alike, so after a return it is the end of the
   * hidden stretch. An update sample whose change happened at or before it
   * spent part of its life in a throttled background tab (`isHiddenSince`).
   * Per client, and the client is the page's one module singleton.
   */
  private lastHiddenAt: number | null = null;
  /** `online` / `visibilitychange` handlers (event-driven retry + `lastHiddenAt`), removed in `destroy()`. */
  private retryListeners: {
    online: () => void;
    visibility: () => void;
  } | null = null;
  /**
   * `performance.now()` timestamp the live-state transport FIRST reached the
   * aggregate `"open"` status (null until then). This is the cold-start marker:
   * a resource that mounts before this is set waited on transport bring-up for
   * (at least part of) its settle window, so its mount→first-data duration is
   * time-to-first-data over the transport, not the resource's own compute cost.
   * Set once, never reset — a later reconnect does not re-arm cold-start.
   */
  private firstReadyAt: number | null = null;
  /**
   * Per-channel twin of `firstReadyAt`: the worktree and central sockets are
   * independent, so a worktree resource's cold-start decision must not hinge on
   * the central channel's readiness (or vice-versa). Stamped the first instant
   * each channel's own url reaches "open"; read by `hasEverBeenReady(origin)`.
   * One-way latch per kind — never reset on a later reconnect.
   */
  private firstReadyByKind: Record<SocketKind, number | null> = {
    worktree: null,
    central: null,
  };

  constructor(
    /**
     * The cache this client writes — and the one its provider mounts: the
     * pair is built together, so a provider can never hand React a cache the
     * client does not write (`NotificationsClientProvider`).
     */
    readonly queryClient: QueryClient,
    hooks?: {
      makeSocket?: (
        url: string,
        options: SharedWebSocketOptions,
      ) => TransportSocket;
      /** Maps a socket path to the URL it opens at (default: the path itself). */
      socketUrl?: (path: string) => string;
      tabId?: string;
      fetchImpl?: (
        ...args: Parameters<typeof fetch>
      ) => ReturnType<typeof fetch>;
      registries?: LiveRegistries;
      /**
       * Whether the telemetry this client's reads raise is reported (a live
       * read's error, a stale drop, the update latency sample): its
       * transport's `telemetry`. Default true — the page's.
       */
      telemetry?: boolean;
    },
  ) {
    // Socket factory must be set before channelFor (openChannel reads it).
    const makeSocket =
      hooks?.makeSocket ??
      ((u: string, options: SharedWebSocketOptions) =>
        new SharedWebSocket(u, undefined, options));
    // Every socket names the frame vocabulary it reads (`SOCKET_OPTIONS`).
    this.makeSocket = (u) => makeSocket(u, SOCKET_OPTIONS);
    const socketUrl = hooks?.socketUrl ?? ((path: string) => path);
    this.socketUrls = {
      worktree: socketUrl(WS_URLS.worktree),
      central: socketUrl(WS_URLS.central),
    };
    this.registries = hooks?.registries ?? rootLiveRegistries;
    this.fetchImpl = hooks?.fetchImpl ?? ((...a) => fetch(...a));
    this.tabId = hooks?.tabId ?? REALM_HOLDER_ID;
    this.telemetry = hooks?.telemetry ?? true;
    // Open the worktree channel eagerly (always used). Central stays lazy —
    // opened on the first central-origin observe() via channelFor.
    this.channelFor("worktree");
    this.unsubscribeFromBus = subscribeWsStatus(({ url, status }) => {
      const kind = this.socketKindOf(url);
      if (kind === null) return;
      if (this.channelStatuses.get(url) !== status)
        this.serverFlushOpenMs[kind] = 0;
      this.channelStatuses.set(url, status);
      // Stamp the first instant THIS channel reached "open" (per-origin cold-
      // start latch; see `firstReadyByKind`). Written once per kind, never
      // re-armed — read by `hasEverBeenReady(origin)`.
      if (status === "open" && this.firstReadyByKind[kind] === null) {
        this.firstReadyByKind[kind] = performance.now();
      }
      const next = this.getStatus();
      // Stamp the first instant the aggregate transport reached "open" (cold-
      // start marker; see `firstReadyAt`). Written once, never re-armed.
      if (next === "open" && this.firstReadyAt === null) {
        this.firstReadyAt = performance.now();
      }
      for (const fn of this.statusListeners) fn(next);
      const channels = this.getChannelStatuses();
      for (const fn of this.channelStatusListeners) fn(channels);
      this.emitDebug();
    });
    // Net-diag forwarder: the networking layer publishes socket/port
    // transitions to an event bus (it must not depend on log-channels — that
    // would form networking ↔ log-channels). Forward every event to the trace
    // channel here, where importing clientLog is legal. In production the client
    // is a module singleton, so this never needs teardown; the unsubscriber is
    // captured only so `destroy()` (tests) can release the module-level bus.
    this.unsubscribeFromNetDiag = subscribeNetDiag((ev: NetDiagEvent) => {
      trace(`net-diag ${JSON.stringify(ev)}`);
      this.emitDebug();
    });
    if (typeof window !== "undefined") {
      // Event-driven retry for failed reads — no timer, no polling: the two
      // moments a failure is likely to have healed are the network coming back
      // and the user coming back to the tab. Only tuples in error are refetched
      // (a healthy read is already live over the socket).
      const visibility = () => {
        this.lastHiddenAt = Date.now();
        if (document.visibilityState === "visible")
          this.retryFailing("visible");
      };
      const online = () => this.retryFailing("online");
      this.retryListeners = { online, visibility };
      window.addEventListener("online", online);
      document.addEventListener("visibilitychange", visibility);
    }
    this.unsubscribeFromQueryCache = this.queryClient
      .getQueryCache()
      .subscribe((event) => this.noteQueryError(event));
  }

  /**
   * Classify a ws-status-bus url as one of THIS client's sockets, or null — the
   * per-pipeline twin of `liveStateSocketKind`, which knows only the page's own
   * pipeline's URLs.
   */
  socketKindOf(url: string): LiveStateSocketKind | null {
    for (const kind of Object.keys(this.socketUrls) as SocketKind[]) {
      if (url === this.socketUrls[kind]) return kind;
    }
    return null;
  }

  getStatus(): WsStatus {
    const vals = [...this.channelStatuses.values()];
    if (vals.length === 0) return "connecting";
    if (vals.some((s) => s === "reconnecting")) return "reconnecting";
    if (vals.some((s) => s === "closed")) return "closed";
    if (vals.some((s) => s === "connecting")) return "connecting";
    return "open";
  }

  /**
   * `performance.now()` of the first moment the transport reached `"open"`, or
   * null if it has never been ready yet. Used by `useResource` to attribute a
   * cold-start resource settle to transport bring-up rather than the resource.
   */
  getFirstReadyAt(): number | null {
    return this.firstReadyAt;
  }

  /** Has the transport for this origin's channel EVER reached "open"? A one-way
   *  latch (never reset) used by useResource to decide whether a cold-start HTTP
   *  prime is warranted. */
  hasEverBeenReady(origin?: ResourceOrigin): boolean {
    return this.firstReadyByKind[socketKindFor(origin)] !== null;
  }

  /**
   * Where (key, params)'s value was last written on the client-wide apply
   * sequence — the higher of two tuples' holds the more recently applied
   * value. `0`: this tab holds no sub for it, or nothing was applied on it
   * yet (a boot-hydrated value included).
   */
  appliedSeq(
    key: string,
    params: ResourceParams = {},
    origin?: ResourceOrigin,
  ): number {
    const channel = this.channels[socketKindFor(origin)];
    return channel?.subs.get(`${key}\0${paramsKey(params)}`)?.appliedSeq ?? 0;
  }

  subscribeStatus(fn: (s: WsStatus) => void): () => void {
    fn(this.getStatus());
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  getChannelStatuses(): ChannelStatuses {
    return {
      worktree:
        this.channelStatuses.get(this.socketUrls.worktree) ?? "connecting",
      central:
        this.channelStatuses.get(this.socketUrls.central) ?? "connecting",
      serverFlushOpenMs: { ...this.serverFlushOpenMs },
    };
  }

  /**
   * Record a heartbeat's `flushOpenMs` for `kind`. Notifies channel-status
   * listeners only when the value moved, so an idle server's pings (0 → 0)
   * re-render nothing. Every tab records it: the shared socket broadcasts every
   * frame, pings included, to all tabs.
   */
  private noteServerFlushOpenMs(kind: SocketKind, raw: unknown): void {
    const ms = raw ?? 0;
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
      throw new Error(
        `[notifications] ping carried a malformed flushOpenMs: ${JSON.stringify(raw)}`,
      );
    }
    if (this.serverFlushOpenMs[kind] === ms) return;
    this.serverFlushOpenMs[kind] = ms;
    const channels = this.getChannelStatuses();
    for (const fn of this.channelStatusListeners) fn(channels);
    this.emitDebug();
  }

  subscribeChannelStatuses(fn: (s: ChannelStatuses) => void): () => void {
    fn(this.getChannelStatuses());
    this.channelStatusListeners.add(fn);
    return () => this.channelStatusListeners.delete(fn);
  }

  // --- Layer 2/3 introspection + control API --------------------------------

  /**
   * Probe for live frames silently missed while the tab was hidden. Forces a
   * resync of every active sub (reuses the reconnect `replaySubs` path — also a
   * cheap stale-cache self-heal), waits `settleMs` for the sub-acks to land, then
   * returns only the subs that were genuinely behind.
   *
   * A sub is a genuine miss iff all three hold:
   *  - it had a baseline before the probe (`prevVersion >= 0`),
   *  - its resync sub-ack revealed a higher server version
   *    (`lastAckVersion > prevVersion`) — the gap, AND
   *  - no live frame landed for it during the probe (`liveFrameSeq` unchanged) —
   *    so the advance was revealed *only* by the ack, not delivered live.
   *
   * Comparing the sub-ack version (not the running `version`) excludes any live
   * frame that arrives during the settle window; the `liveFrameSeq` guard closes
   * the residual ~1-RTT race where a notify lands between the re-sub and its ack.
   *
   * A sub whose channel's socket (re)opened during the probe is never a miss:
   * the probe's batch (queued while the socket was down, flushed onto the new
   * one) or the reopen's own replay lands on a socket the server holds nothing
   * for, so every tuple opens a new tracking span at a higher version — a
   * re-baseline, not a frame the live socket dropped.
   */
  async probeMissedUpdates(settleMs = 1_500): Promise<MissedFrame[]> {
    const before: {
      id: string;
      socket: SocketKind;
      prevVersion: number;
      prevLiveSeq: number;
      prevOpens: number;
    }[] = [];
    for (const [kind, channel] of Object.entries(this.channels) as [
      SocketKind,
      SocketChannel,
    ][]) {
      for (const [id, sub] of channel.subs) {
        before.push({
          id,
          socket: kind,
          prevVersion: sub.version,
          prevLiveSeq: sub.liveFrameSeq,
          prevOpens: channel.opens,
        });
      }
    }
    if (before.length === 0) return [];
    trace(`probeMissedUpdates subCount=${before.length}`);
    for (const channel of Object.values(this.channels) as SocketChannel[]) {
      // Same batch replay as a reconnect: the whole set goes out in ONE
      // synchronous frame (baselines reset at build time), so `lastAckVersion`
      // is -1 before the settle window opens and every ack lands inside it.
      this.replaySubs(channel);
    }
    // One-shot wait for the sub-ack round-trip — not a poll. The ack landing is
    // what `lastAckVersion` captures.
    await new Promise<void>((resolve) => setTimeout(resolve, settleMs));

    const missed: MissedFrame[] = [];
    for (const b of before) {
      // Re-look up by id: a refcount-0 sub may have torn down mid-probe.
      const channel = this.channels[b.socket];
      const sub = channel?.subs.get(b.id);
      if (!sub) continue;
      // Reopened mid-probe: a re-baseline, never a miss (see the doc above).
      if (channel!.opens !== b.prevOpens) continue;
      if (
        b.prevVersion >= 0 &&
        sub.lastAckVersion > b.prevVersion &&
        sub.liveFrameSeq === b.prevLiveSeq
      ) {
        missed.push({
          key: sub.key,
          params: sub.params,
          socket: sub.socket,
          prevVersion: b.prevVersion,
          ackVersion: sub.lastAckVersion,
        });
      }
    }
    return missed;
  }

  /**
   * Push-based snapshot of all active subs plus socket + transport state, for the
   * live-state-health inspector. Pair with `subscribeDebug` to re-render on
   * change.
   */
  debugSnapshot(): DebugSnapshot {
    const subs: DebugSub[] = [];
    for (const channel of Object.values(this.channels) as SocketChannel[]) {
      for (const [id, sub] of channel.subs) {
        subs.push({
          key: sub.key,
          paramsKey: id.slice(id.indexOf("\0") + 1),
          version: sub.version,
          lastAppliedAt: sub.lastAppliedAt,
          refcount: sub.refcount,
          socket: sub.socket,
        });
      }
    }
    return {
      subs,
      sockets: this.getChannelStatuses(),
      transport: {
        worktree: this.transportInfo("worktree"),
        central: this.transportInfo("central"),
      },
    };
  }

  /** Fires whenever a sub/version/socket/transport state changes. */
  subscribeDebug(listener: () => void): () => void {
    this.debugListeners.add(listener);
    return () => this.debugListeners.delete(listener);
  }

  private transportInfo(kind: SocketKind): TransportInfo {
    // Read without creating: a never-opened channel (e.g. central on an app with
    // no central resources) reports nothing — never open it to answer.
    const channel = this.channels[kind];
    if (!channel) return { attachedTabs: null, connection: null };
    const ws = channel.ws;
    return { attachedTabs: ws.attachedTabs, connection: ws.connection };
  }

  private emitDebug(): void {
    for (const fn of this.debugListeners) fn();
  }

  /**
   * Release every resource this client holds. Inert in production (the client is
   * a module singleton, never destroyed); the complete teardown exists so a test
   * leaves no dangling module-level bus subscription, deferred-teardown timer, or
   * open socket to leak into the next test.
   */
  destroy(): void {
    this.unsubscribeFromBus();
    this.unsubscribeFromNetDiag();
    if (this.retryListeners !== null) {
      window.removeEventListener("online", this.retryListeners.online);
      document.removeEventListener(
        "visibilitychange",
        this.retryListeners.visibility,
      );
      this.retryListeners = null;
    }
    this.unsubscribeFromQueryCache();
    for (const channel of Object.values(this.channels) as SocketChannel[]) {
      for (const timer of channel.pendingTeardown.values()) clearTimeout(timer);
      channel.pendingTeardown.clear();
      clearTimeout(channel.unansweredTimer);
      channel.unansweredTimer = undefined;
      channel.ws.close();
    }
  }

  // --- Failing reads (error bookkeeping, report sink, event-driven retry) ------

  /** Every live read currently failing, one entry per `(key, params)` tuple. */
  getFailingResources(): readonly FailingResource[] {
    return this.failingSnapshot;
  }

  subscribeFailingResources(listener: () => void): () => void {
    this.failingListeners.add(listener);
    return () => this.failingListeners.delete(listener);
  }

  /**
   * Keep `failing` in step with the query cache: a live-state tuple whose query
   * gains an error enters it (and is reported ONCE, however many hooks observe
   * it); one whose error clears — a push, a successful refetch, the
   * `up-to-date` clear — or whose query is garbage-collected leaves it. Runs on
   * every cache event, so the common case (no error, nothing failing) returns
   * before any key work.
   */
  private noteQueryError(event: QueryCacheNotifyEvent): void {
    if (event.type !== "updated" && event.type !== "removed") return;
    const raw = event.type === "removed" ? null : event.query.state.error;
    // A refused read is not failing: the server answered — "this question
    // cannot be asked like that" — and the read renders that answer. It is no
    // page-health problem and nothing to report.
    const error =
      raw !== null && toResourceError(raw).kind === "refused" ? null : raw;
    if (error === null && this.failing.size === 0) return;
    const tuple = resourceTupleOf(event.query.queryKey);
    if (tuple === null) return;
    const id = `${tuple.key}\0${paramsKey(tuple.params)}`;
    const had = this.failing.get(id);
    if (error === null) {
      if (had === undefined) return;
      this.failing.delete(id);
      trace(`error-cleared key=${tuple.key} params=${paramsKey(tuple.params)}`);
      this.emitFailing();
      return;
    }
    const typed = toResourceError(error);
    if (had !== undefined) {
      // Still failing — a retry failed again. Keep the latest error on the
      // entry (the health row names it) without re-reporting the episode.
      if (had.error !== typed) {
        this.failing.set(id, { ...had, error: typed });
        this.emitFailing();
      }
      return;
    }
    // Only a tuple THIS client subscribes to is a live read — the query cache
    // is shared with every other `useQuery` user (endpoints) on the page.
    if (!this.holdsSub(tuple.key, tuple.params)) return;
    const entry = { key: tuple.key, params: tuple.params, error: typed };
    this.failing.set(id, entry);
    trace(
      `error key=${tuple.key} params=${paramsKey(tuple.params)} kind=${typed.kind} error=${typed.message}`,
    );
    if (this.telemetry) resourceErrorReportSink.emit(entry);
    this.emitFailing();
  }

  private emitFailing(): void {
    this.failingSnapshot = [...this.failing.values()];
    for (const fn of this.failingListeners) fn();
  }

  private holdsSub(key: string, params: ResourceParams): boolean {
    const id = `${key}\0${paramsKey(params)}`;
    for (const channel of Object.values(this.channels) as SocketChannel[]) {
      if (channel.subs.has(id)) return true;
    }
    return false;
  }

  /**
   * Refetch every failing read that something still observes — the
   * `online` / `visibilitychange → visible` retry. Goes through the query
   * itself (not `refetchQueries`, which skips a disabled query: a `liveValue`
   * that never got a value is disabled until one lands, and is exactly the read
   * that most needs the retry). The outcome lands on the query's state, where
   * the read's `error` arm already renders it — so the promise's rejection is
   * the query's own business, traced here and nothing more.
   */
  private retryFailing(trigger: "online" | "visible"): void {
    for (const { key, params } of this.failing.values()) {
      const query = this.queryClient
        .getQueryCache()
        .find({ queryKey: queryKeyFor(key, params), exact: true });
      if (query === undefined || query.getObserversCount() === 0) continue;
      trace(`retry key=${key} params=${paramsKey(params)} trigger=${trigger}`);
      void query.fetch().then(
        () => undefined,
        (err: unknown) => {
          trace(
            `retry failed key=${key} params=${paramsKey(params)} error=${String(err)}`,
          );
        },
      );
    }
  }

  /**
   * A value-less `up-to-date` reply says the value this tab holds is current —
   * so a failure the tuple's query still carries (an HTTP fallback that failed
   * while the socket was down) no longer describes it. Clear exactly that
   * query's error, and nothing else: no data write, so no cache event a value
   * listener could mistake for a fresh push. `Query.setState` is React Query's
   * public state seam; this is its one use in live-state.
   */
  private clearStaleError(key: string, params: ResourceParams): void {
    const query: Query | undefined = this.queryClient
      .getQueryCache()
      .find({ queryKey: queryKeyFor(key, params), exact: true });
    if (query === undefined || query.state.error === null) return;
    query.setState({
      error: null,
      status: "success",
      fetchFailureCount: 0,
      fetchFailureReason: null,
    });
    trace(`up-to-date cleared error key=${key} params=${paramsKey(params)}`);
  }

  /**
   * Observer count increased for (key, params). Sub on 0→1 — seeded from
   * rows this tab holds when `derive` names them and they still stand as
   * decided (see `ResourceDerivation`); `derive` is read on that fresh sub
   * only, never on a refcount bump.
   */
  observe(
    key: string,
    params: ResourceParams = {},
    origin?: ResourceOrigin,
    read?: ResourceRead<unknown>,
    keyOf?: (row: unknown) => string,
    derive?: ResourceDerivation,
  ): void {
    if (read) this.reads.set(key, read);
    if (keyOf) this.keyedKeyOf.set(key, keyOf);
    const kind = socketKindFor(origin);
    // The ONLY path that may lazily create a channel: the first central-origin
    // observe() opens the central socket; every read-only path below only reads.
    const channel = this.channelFor(kind);
    const pk = paramsKey(params);
    const id = `${key}\0${pk}`;
    const existing = channel.subs.get(id);
    if (existing) {
      // Resurrection: a refcount-0 sub still inside its keep-alive window is
      // alive again with zero WS traffic — cancel the pending teardown. This is
      // a pure refcount bump, not a transition, so the always-on trace stays
      // silent (only emitDebug fires, to keep the health inspector accurate).
      const pending = channel.pendingTeardown.get(id);
      if (pending !== undefined) {
        clearTimeout(pending);
        channel.pendingTeardown.delete(id);
      }
      existing.refcount++;
      this.emitDebug();
      return;
    }
    const seed =
      derive === undefined ? null : this.seedOf(channel, key, pk, derive);
    channel.subs.set(id, {
      refcount: 1,
      key,
      params,
      version: -1,
      lastAckVersion: -1,
      liveFrameSeq: 0,
      socket: kind,
      lastAppliedAt: 0,
      appliedSeq: 0,
      socketValue: false,
      ...(seed !== null
        ? { derivation: { rows: seed.rows, id: seed.frame.id } }
        : {}),
    });
    trace(`observe key=${key} params=${pk} refcount=1`);
    this.sendSub(channel, key, params, seed?.frame);
    this.emitDebug();
  }

  /**
   * A derivation's rows and wire form, cut from the sources' cached values —
   * or `null` (traced) when a source no longer stands as the caller decided:
   * not held, applied since (`appliedSeq`), not a socket-built value, or a
   * bound naming no row of it. Then the sub simply loads.
   */
  private seedOf(
    channel: SocketChannel,
    key: string,
    pk: string,
    derive: ResourceDerivation,
  ): { rows: unknown[]; frame: DerivationFrame } | null {
    const skip = (reason: string) => {
      trace(`derive skipped key=${key} params=${pk} reason=${reason}`);
      return null;
    };
    const keyOf = this.keyedKeyOf.get(key);
    if (keyOf === undefined) return skip("not-keyed");
    if (derive.from.length === 0) return skip("no-source");
    if (derive.from.length > DERIVE_MAX_SOURCES) return skip("sources");
    const rows: unknown[] = [];
    const from: DeriveSource[] = [];
    for (const slice of derive.from) {
      const src = channel.subs.get(`${key}\0${paramsKey(slice.params)}`);
      if (src === undefined) return skip("source-not-held");
      if (src.appliedSeq === 0) {
        // Nothing applied through this tab's sub yet: its first answer has
        // not landed. Either the source is itself still loading (a fresh sub,
        // or a derivation of its own in flight) — nothing to count — or the
        // value it holds is a boot-hydrated one, whose version the server
        // cannot match. That case is accepted (a split there loads in full:
        // latency, not correctness), and counted, one line per refused seed,
        // on the paged read's channel to keep it so
        // (research/2026-10-12-global-live-paging-followups.md).
        if (
          src.derivation !== undefined ||
          this.queryClient.getQueryData(queryKeyFor(key, slice.params)) ===
            undefined
        ) {
          return skip("source-loading");
        }
        clientLog(
          "live-pages",
          `[${key}] seed refused: a source holds a boot-hydrated value (params=${pk})`,
        );
        return skip("source-hydrated");
      }
      if (src.appliedSeq !== slice.appliedSeq) return skip("source-moved");
      if (!src.socketValue || src.version < 0) return skip("source-not-socket");
      const held = this.queryClient.getQueryData(
        queryKeyFor(key, slice.params),
      );
      if (!Array.isArray(held)) return skip("source-not-held");
      const ids = held.map(keyOf);
      const start = slice.after === null ? 0 : ids.indexOf(slice.after) + 1;
      const end =
        slice.until === null ? ids.length : ids.indexOf(slice.until) + 1;
      if (
        (slice.after !== null && start === 0) ||
        (slice.until !== null && end === 0) ||
        end < start
      ) {
        return skip("slice");
      }
      rows.push(...held.slice(start, end));
      from.push({
        params: slice.params,
        version: src.version,
        after: slice.after,
        until: slice.until,
      });
    }
    // Minted per derivation, never reused: a tab (or a duplicated tab, which
    // copies its session id) asking the same slices twice tells its answers
    // apart.
    return { rows, frame: { id: crypto.randomUUID(), from } };
  }

  /**
   * Observer count decreased. Unsub on 1→0 — after the keep-alive window by
   * default (a transient remount reuses the live sub), or at once with
   * `release: "now"`: a reader that dropped the tuple on purpose (a paged
   * read's page scrolled out of its band) and will not remount it. A tuple
   * released at once also drops its cached value: nothing keeps it current
   * any more, so a later observe must read `loading` until the server vouches
   * for a value again — never hand the old one back as `ready`.
   */
  unobserve(
    key: string,
    params: ResourceParams = {},
    origin?: ResourceOrigin,
    release: "keep-alive" | "now" = "keep-alive",
  ): void {
    const kind = socketKindFor(origin);
    // Read-only: an unobserve can only be reached for an origin a prior observe()
    // already created the channel for. Guard defensively (never create it here).
    const channel = this.channels[kind];
    if (!channel) return;
    const pk = paramsKey(params);
    const id = `${key}\0${pk}`;
    const existing = channel.subs.get(id);
    if (!existing) return;
    existing.refcount--;
    if (existing.refcount > 0) {
      // Pure refcount decrement, not a transition: stay silent on the always-on
      // trace (emitDebug keeps the health inspector accurate).
      this.emitDebug();
      return;
    }
    if (release === "now") {
      channel.subs.delete(id);
      this.queryClient.removeQueries({
        queryKey: queryKeyFor(key, params),
        exact: true,
      });
      channel.ws.send(wire({ op: "unsub", key, params, tabId: this.tabId }));
      trace(`unobserve key=${key} params=${pk} refcount=0 released now`);
      this.emitDebug();
      return;
    }
    // Last observer left: defer the WS unsub by one keep-alive window so a
    // transient remount reuses the live sub. The sub stays in `channel.subs`
    // with refcount 0 until the timer fires (or a resurrecting observe() cancels
    // it). One-shot deferred cleanup — see SUB_KEEPALIVE_MS; not a poll.
    trace(
      `unobserve key=${key} params=${pk} refcount=0 keepAliveMs=${SUB_KEEPALIVE_MS}`,
    );
    this.emitDebug();
    const timer = setTimeout(() => {
      const sub = channel.subs.get(id);
      // Resurrected (refcount back above 0) between scheduling and firing, or
      // already torn down — just drop the stale timer entry and do nothing.
      if (!sub || sub.refcount > 0) {
        channel.pendingTeardown.delete(id);
        return;
      }
      channel.subs.delete(id);
      channel.pendingTeardown.delete(id);
      channel.ws.send(wire({ op: "unsub", key, params, tabId: this.tabId }));
      trace(`teardown key=${key} params=${pk}`);
      this.emitDebug();
    }, SUB_KEEPALIVE_MS);
    channel.pendingTeardown.set(id, timer);
  }

  /**
   * Ask the server for standalone `{ kind: "ack" }` frames on (key, params) —
   * the frames a recompute that changed nothing visible sends so an
   * optimistic op's exact-ack confirmation does not hang. Counted per tuple
   * (OR across this tab's readers; the server ORs across tabs); returns the
   * release. Independent of `observe()`: the flag rides the tuple's `sub`
   * frame whenever the count is positive, and a 0→1 / 1→0 transition while
   * the sub is live flips it with one `op: "sub-acks"` frame (no re-sub, no
   * loader run).
   */
  requestAcks(
    key: string,
    params: ResourceParams = {},
    origin?: ResourceOrigin,
  ): () => void {
    const channel = this.channelFor(socketKindFor(origin));
    const id = `${key}\0${paramsKey(params)}`;
    const prev = channel.ackInterest.get(id) ?? 0;
    channel.ackInterest.set(id, prev + 1);
    if (prev === 0) this.sendSubAcks(channel, id, key, params, true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (channel.ackInterest.get(id) ?? 0) - 1;
      if (n > 0) {
        channel.ackInterest.set(id, n);
        return;
      }
      channel.ackInterest.delete(id);
      this.sendSubAcks(channel, id, key, params, false);
    };
  }

  private wantsAcks(channel: SocketChannel, id: string): boolean {
    return (channel.ackInterest.get(id) ?? 0) > 0;
  }

  // The ack flag flip for a LIVE sub. Without one there is nothing to flip on
  // the server — the next `sub` frame carries the flag instead.
  private sendSubAcks(
    channel: SocketChannel,
    id: string,
    key: string,
    params: ResourceParams,
    acks: boolean,
  ): void {
    if (!channel.subs.has(id)) return;
    trace(
      `subAcks key=${key} params=${paramsKey(params)} acks=${acks ? 1 : 0}`,
    );
    channel.ws.send(
      wire({ op: "sub-acks", key, params, acks, tabId: this.tabId }),
    );
  }

  // --- Conditional-revalidation ETag accessors (HTTP fallback path) -----------

  /**
   * Last-known ETag for (key, params) on its channel, so `useResource`'s HTTP
   * fallback can send `If-None-Match` and get a `304` for an unchanged resource
   * instead of recomputing the loader. Undefined when the resource hasn't opted
   * in or no value has arrived yet.
   */
  etagFor(
    key: string,
    params: ResourceParams = {},
    origin?: ResourceOrigin,
  ): string | undefined {
    // Read-only: reachable only after an observe() created this origin's channel.
    const channel = this.channels[socketKindFor(origin)];
    return channel?.subs.get(`${key}\0${paramsKey(params)}`)?.etag;
  }

  /**
   * Store the ETag from an HTTP GET's `ETag` response header onto the live sub
   * entry, so the next conditional GET / resubscribe can send it. No-op when the
   * header is absent (resource didn't opt in) or no sub exists yet (a fetch that
   * raced ahead of observe() — the etag is then captured on the next GET / the WS
   * sub-ack).
   */
  noteHttpEtag(
    key: string,
    params: ResourceParams = {},
    origin: ResourceOrigin | undefined,
    etag: string | null,
  ): void {
    if (etag == null) return;
    // Read-only: reachable only after an observe() created this origin's channel.
    const sub = this.channels[socketKindFor(origin)]?.subs.get(
      `${key}\0${paramsKey(params)}`,
    );
    if (sub) sub.etag = etag;
  }

  /** Current cached value for (key, params) — read by the HTTP 304 keep-cache path. */
  getCachedResource(key: string, params: ResourceParams = {}): unknown {
    return this.queryClient.getQueryData(queryKeyFor(key, params));
  }

  /**
   * Has a server-vouched value EVER landed in the cache for (key, params)? True
   * iff `dataUpdatedAt` has left epoch 0 — the exact signal `use-resource.ts`
   * reads for its `pending` flag, so this and every read agree on when a
   * tuple settled. This is what separates "cache holds newer server truth"
   * (keep it) from "cache holds nothing the server vouched for" (must not
   * settle with it).
   */
  private hasAppliedValue(key: string, params: ResourceParams): boolean {
    return (
      (this.queryClient.getQueryState(queryKeyFor(key, params))
        ?.dataUpdatedAt ?? 0) !== 0
    );
  }

  /**
   * THE single HTTP resource-cache write path. Fetches a resource's `{ value,
   * version, epoch?, watermark? }` over plain HTTP (`cache: "no-store"` so the
   * browser cache can never hand back an old-boot body — the poisoning class this
   * closes; conditional `If-None-Match`/304) and writes it through an epoch-aware
   * version guard, so a late or old-boot HTTP response can never clobber a newer
   * WS value. Returns the EFFECTIVE cached value — the freshly-applied one, or the
   * retained value on a `304`/stale drop — so React Query's `queryFn` contract
   * holds (data returned, `dataUpdatedAt` bumps, `pending` flips) with no separate
   * render path.
   *
   * Version guard: server versions are per-`(key,params)` in-memory counters that
   * reset each boot, so a raw comparison is only meaningful WITHIN one boot. When
   * the body carries an `epoch` (its boot identity) and we hold a sub `entry`:
   *   - same boot as `entry` (or `entry` not yet epoch-stamped): strict `<` drop —
   *     an HTTP GET reports the counter without bumping it, so a legitimate
   *     response can EQUAL the version we hold (the normal `invalidate`-mode
   *     refetch), which `<` accepts;
   *   - `entry` is a stale boot but the body matches the live WS server identity:
   *     ADOPT (the live response beats a cached memory of an older boot);
   *   - the body is a stale boot while `entry` matches the live server: DROP
   *     (`stale-epoch`);
   *   - neither matches the live server (the WS-down fallback window): ADOPT — a
   *     live response beats a memory of unknown vintage, and dropping would starve
   *     the fallback this function exists to serve.
   * An epoch-less body (pre-upgrade server) keeps the strict-`<` behavior byte-for-
   * byte. On a cross-epoch adopt the entry's `version`/`epoch` are re-stamped from
   * the body (the old-boot number is meaningless); a same-epoch apply keeps the
   * monotonic bump.
   *
   * On a DROP: if a server-vouched value was ever applied, the cache holds newer
   * truth — return it. Otherwise throw `ResourceStaleReadError` — NEVER settle the
   * query on a value the server never vouched for (the "Close (state unknown)"
   * wedge) nor apply the stale body (old-boot data under destructive buttons). Every drop
   * also feeds the stale-drop report sink with the running consecutive count.
   *
   * Throws on network (`fetch` `TypeError`), HTTP status (`ResourceHttpError`),
   * stale never-applied read (`ResourceStaleReadError`), or schema/parse failure —
   * callers choose how to surface each.
   */
  async fetchOverHttp<T>(
    key: string,
    params: ResourceParams,
    origin: ResourceOrigin | undefined,
    read: ResourceRead<T>,
    source: "prime" | "fallback",
  ): Promise<T> {
    const { schema } = read;
    const channel = this.channels[socketKindFor(origin)];
    const entry = channel?.subs.get(`${key}\0${paramsKey(params)}`);
    const serverEpoch = channel?.serverEpoch;
    const qs = new URLSearchParams(params).toString();
    const base =
      origin === "central" ? "/api/central-resources" : "/api/resources";
    const url = `${base}/${encodeURIComponent(key)}${qs ? `?${qs}` : ""}`;
    const etag = this.etagFor(key, params, origin);
    // `cache: "no-store"` on BOTH fetches: the browser HTTP cache must never
    // store or transparently 304-revalidate a resource body — a restart-stable
    // ETag would otherwise let it replay an old-boot `{value, version}`.
    // Every read names this tab's build, so a contract mismatch is judged
    // skew (reload) or a real bug on the server (the `sub` frame's twin).
    const build = { [BUILD_GRAPH_HEADER]: clientBuild() };
    let res = await this.fetchImpl(
      url,
      etag !== undefined
        ? {
            cache: "no-store",
            headers: { ...build, "If-None-Match": etag },
          }
        : { cache: "no-store", headers: build },
    );
    if (res.status === 304) {
      const cached = this.getCachedResource(key, params);
      // "Still current" — keep the cached value ONLY when a server-vouched value
      // was actually applied (same reference; structural sharing sees no change).
      // A 304 against a never-applied entry must NOT settle the query — fall
      // through to the unconditional refetch below.
      if (cached !== undefined && this.hasAppliedValue(key, params))
        return cached as T;
      // 304 with no server-vouched base: re-fetch unconditionally so a
      // needless 304 never leaves the cache empty/stale, then take the write path.
      res = await this.fetchImpl(url, { cache: "no-store", headers: build });
    }
    if (!res.ok) {
      // A failed read carries a typed JSON body (reason + verdict). Read it so
      // the error names WHY — and so a contract refusal reaches the Reload
      // advice even when no WS sub-error did (the socket was down).
      const errBody = parseResourceHttpErrorBody(await readJsonBody(res));
      // A refusal must carry a code this read declares. The server only sends
      // codes ITS declaration lists (the runtime turns any other into a
      // failure), so a code this tab's does not list means the two bundles
      // declare the resource differently: a contract mismatch, the tab out of
      // date — never a refusal the surface would branch on with no type for.
      if (
        errBody?.reason === "refused" &&
        (errBody.code === undefined ||
          !(read.refusals ?? []).includes(errBody.code))
      ) {
        noteContractRefusal(key, "contract-mismatch", "skew");
        throw new ResourceHttpError(
          key,
          res.status,
          "contract-mismatch",
          "skew",
          `refused with ${errBody.code === undefined ? "no code" : `code "${errBody.code}"`}, ` +
            `which this tab's declaration does not list ` +
            `(${JSON.stringify(read.refusals ?? [])}): ${errBody.detail ?? ""}`,
        );
      }
      noteContractRefusal(key, errBody?.reason, errBody?.verdict);
      throw new ResourceHttpError(
        key,
        res.status,
        errBody?.reason,
        errBody?.verdict,
        errBody?.detail,
        errBody?.code,
      );
    }
    // A bytes read's body IS the value; its envelope rides the headers
    // (`parseResourceBytesHeaders` throws on a response that is not one).
    const body: {
      value: unknown;
      version: number;
      epoch?: string;
      watermark?: string;
    } = read.bytes
      ? {
          ...parseResourceBytesHeaders(key, res.headers),
          value: await res.arrayBuffer(),
        }
      : ((await res.json()) as {
          value: unknown;
          version: number;
          epoch?: string;
          watermark?: string;
        });
    this.noteHttpEtag(key, params, origin, res.headers.get("ETag"));

    // Epoch-aware version guard (see doc comment). Compute the adopt/drop decision
    // only when we hold a sub `entry` to compare against; with no entry there is
    // nothing to guard, so apply straight through.
    let drop: "stale-version" | "stale-epoch" | null = null;
    let crossEpochAdopt = false;
    if (entry) {
      if (
        body.epoch === undefined ||
        body.epoch === entry.epoch ||
        entry.epoch === undefined
      ) {
        // Legacy body OR same boot (or entry not yet epoch-stamped): strict `<`.
        if (body.version < entry.version) drop = "stale-version";
      } else if (body.epoch === serverEpoch) {
        // Entry is a stale boot; body matches the live WS server identity → adopt.
        crossEpochAdopt = true;
      } else if (entry.epoch === serverEpoch) {
        // Body is a stale boot while the entry matches the live server → drop.
        drop = "stale-epoch";
      } else {
        // No arbiter (WS-down fallback window): adopt the live response.
        crossEpochAdopt = true;
      }
    }

    if (drop !== null) {
      // entry is non-null whenever drop is set (only that branch assigns it).
      const applied = this.hasAppliedValue(key, params);
      this.emitStaleDrop(
        key,
        params,
        drop,
        body,
        entry!,
        serverEpoch,
        source,
        !applied,
      );
      trace(
        `http drop key=${key} params=${paramsKey(params)} msgVersion=${body.version} haveVersion=${entry!.version} reason=${drop} source=${source}`,
      );
      // Applied → the cache holds newer server-vouched truth; keep it. Never-
      // applied → the cache holds nothing vouched, and settling the query (or
      // applying the stale body) is the wedge. Throw instead: RQ
      // retry + the next invalidate frame converge the legitimate race, and a
      // persistent failure surfaces typed and visible instead of confidently
      // wrong.
      if (applied) return this.getCachedResource(key, params) as T;
      throw new ResourceStaleReadError(key, body.version, entry!.version, drop);
    }

    const parsed = schema.parse(body.value); // schema violation throws — surfaced by the caller
    // Adopt the body's commit watermark AFTER the guard (a stale-dropped response
    // never advances the causal floor) and IMMEDIATELY BEFORE the cache write it
    // describes — same load-bearing order as the WS paths.
    if (body.watermark !== undefined)
      this.registries.watermarks.note(key, params, body.watermark);
    this.queryClient.setQueryData(queryKeyFor(key, params), parsed);
    if (entry) {
      // Read apart from the server's snapshot of the tuple: no derivation may
      // be cut from it (see `ActiveSub.socketValue`).
      entry.socketValue = false;
      entry.wire = undefined;
      if (crossEpochAdopt) {
        // Cross-epoch adopt: the old-boot version number is meaningless, so take
        // the body's version UNCONDITIONALLY and re-stamp the entry's boot
        // identity (body.epoch is defined on every cross-epoch adopt path).
        entry.version = body.version;
        entry.epoch = body.epoch;
      } else if (body.version > entry.version) {
        // Same-epoch (or legacy) apply: advance monotonically (never lower) so a
        // later WS frame at this version is stale-dropped cheaply and a genuinely-
        // newer one still applies. Epoch is left to the WS ack path.
        entry.version = body.version;
      }
      this.markApplied(entry, key); // stamps lastAppliedAt + resets drop count + emitDebug + verbose trace
    }
    trace(
      `http key=${key} params=${paramsKey(params)} version=${body.version} source=${source}`,
    );
    return parsed;
  }

  /** Bump the consecutive-drop counter for (key, params) and emit the running
   *  count to the stale-drop report sink. Called on EVERY `fetchOverHttp` drop
   *  (both same-epoch strict-`<` and cross-boot stale-epoch); the counter resets
   *  in `markApplied` on the next successful apply. */
  private emitStaleDrop(
    key: string,
    params: ResourceParams,
    reason: "stale-version" | "stale-epoch",
    body: { version: number; epoch?: string },
    entry: ActiveSub,
    serverEpoch: string | undefined,
    source: "prime" | "fallback",
    neverApplied: boolean,
  ): void {
    const id = `${key}\0${paramsKey(params)}`;
    const consecutiveDrops = (this.staleDropCounts.get(id) ?? 0) + 1;
    this.staleDropCounts.set(id, consecutiveDrops);
    if (!this.telemetry) return;
    httpStaleDropReportSink.emit({
      key,
      params,
      reason,
      consecutiveDrops,
      bodyVersion: body.version,
      haveVersion: entry.version,
      bodyEpoch: body.epoch ?? null,
      entryEpoch: entry.epoch ?? null,
      serverEpoch: serverEpoch ?? null,
      source,
      neverApplied,
    });
  }

  /** Cold-start accelerator: prime a resource's first value over plain HTTP when
   *  the notifications transport isn't ready yet. Delegates to the shared
   *  version-guarded `fetchOverHttp`; best-effort — the WS sub-ack remains the
   *  source of truth. A transient network / HTTP-status failure is swallowed
   *  (the WS will deliver); a schema/parse failure is a real bug surfaced loudly
   *  (mirroring the WS `onmessage` discipline). Never rejects (safe to `void`). */
  async primeFromHttp(
    key: string,
    params: ResourceParams = {},
    origin?: ResourceOrigin,
  ): Promise<void> {
    const entry = this.channels[socketKindFor(origin)]?.subs.get(
      `${key}\0${paramsKey(params)}`,
    );
    if (!entry) return; // observe() must have created the sub
    const read = this.reads.get(key);
    if (!read) return;
    try {
      await this.fetchOverHttp(key, params, origin, read, "prime");
    } catch (err) {
      if (
        err instanceof TypeError ||
        err instanceof ResourceHttpError ||
        err instanceof ResourceStaleReadError
      ) {
        // Transient network / HTTP-status / stale-read failure during cold boot —
        // non-fatal; prime is best-effort and the WS sub-ack remains the source of
        // truth and will deliver.
        // Each check runs on the full caught union (no cross-narrowing) so the
        // trace label is derived without a nested-instanceof narrow.
        const isNetwork = err instanceof TypeError;
        const isStaleRead = err instanceof ResourceStaleReadError;
        const reason = isNetwork
          ? "network"
          : isStaleRead
            ? "stale-read"
            : "http";
        trace(
          `http drop key=${key} params=${paramsKey(params)} reason=${reason} source=prime error=${String(err)}`,
        );
        return;
      }
      // Schema violation / malformed body is a real bug — surface loudly like the
      // WS onmessage path, without rejecting this promise.
      trace(
        `http error key=${key} params=${paramsKey(params)} source=prime error=${String(err)}`,
      );
      queueMicrotask(() => {
        throw err;
      });
    }
  }

  /**
   * Lazily create + open + cache the channel for `kind`, returning the cached
   * one on every subsequent call. The worktree channel is created eagerly in the
   * constructor; the central channel is created only on the first central-origin
   * `observe()` — the single deliberate creation point (every read-only accessor
   * reads `this.channels[kind]` directly and tolerates its absence). An app with
   * no central resources never opens /ws/central-notifications this way.
   */
  private channelFor(kind: SocketKind): SocketChannel {
    const existing = this.channels[kind];
    if (existing) return existing;
    const channel = this.openChannel(kind);
    this.channels[kind] = channel;
    return channel;
  }

  private openChannel(kind: SocketKind): SocketChannel {
    const channel: SocketChannel = {
      ws: this.makeSocket(this.socketUrls[kind]),
      subs: new Map(),
      pendingTeardown: new Map(),
      ackInterest: new Map(),
      opens: 0,
    };
    // However this tab leaves — close, pagehide, crash — the worker tells the
    // server to release every sub it holds, so a departed tab's subs stop
    // fanning out at once instead of leaking until the socket cycles.
    channel.ws.setLastWill(wire({ op: "unsub-tab", tabId: this.tabId }));
    channel.ws.onopen = () => {
      channel.opens++;
      this.replaySubs(channel);
    };
    channel.ws.onmessage = (ev) => {
      // Receipt stamp BEFORE the parse: decoding is client work, so it lands
      // in an update sample's `client-apply` phase, not in `transport`.
      const receivedAt = Date.now();
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
        trace(`drop reason=parse-error error=${String(err)}`);
        return;
      }
      try {
        this.handleServerMessage(channel, msg, receivedAt);
      } catch (err) {
        // A schema.parse failure would otherwise silently leave the cache at
        // its empty default. Re-throw asynchronously so the global browser
        // crash reporter observes it as an uncaught error — without importing
        // the crashes plugin (live-state ← crashes would be an import cycle)
        // and without breaking the WS loop for subsequent messages.
        trace(
          `drop reason=parse-error key=${msg.kind === "ping" ? "ping" : ((msg as { key?: string }).key ?? "?")} error=${String(err)}`,
        );
        queueMicrotask(() => {
          throw err;
        });
      }
    };
    return channel;
  }

  /**
   * Resend ALL of a channel's subs as ONE `sub-batch` frame — after a fresh
   * connection (the server has no record of our subs) and for the missed-update
   * probe's forced resync. Per sub, the local versions reset to the -1 "nothing
   * applied yet" baseline so the next ack always applies — even a
   * never-notified resource's version-0 sub-ack, and even a lower version after
   * a server restart reset its counters. The pre-reset version is echoed in the
   * batch entry (with the channel's known server epoch) so a SAME-boot server
   * answers every already-current sub from its in-memory version counter — one
   * `up-to-date-batch` frame, zero loader runs.
   *
   * **Echo `version`/`etag` ONLY when we can still back them with a value**
   * (`hasAppliedValue`) — THE INVARIANT (see `handleServerMessage`): a sub's
   * `version`/`etag` name a value THIS tab actually holds. It used to be assumed
   * that "the cached TanStack value survives a reconnect (the socket dropped, not
   * the page)", but the sub outlives the cache entry: React Query gc's an
   * observer-less query after `gcTime` (5 min), while the sub lives on in
   * `channel.subs`. A boot-hydrated config for an app the user has not opened is
   * exactly that — so an unqualified echo asks the server to short-circuit a
   * value we no longer have, and the answering `up-to-date` carries none. Omit
   * both and the server takes the full path and sends the value.
   *
   * Snapshot + build + send happen in ONE synchronous task, so an `observe()`
   * cannot interleave between the baseline reset and the send, and the probe
   * can read `lastAckVersion` after a fixed settle with no late-batch blind
   * spot. (The old per-sub stagger is gone: same-boot replays short-circuit
   * server-side for ~0, and post-restart replays are bounded by the server's
   * read-admission gate + single-flight dedup — the correct layer for herd
   * control, not client-side pacing.)
   *
   * Subs in their keep-alive window (refcount 0, still in `channel.subs`) are
   * resent here too. That's intentional and harmless: their pendingTeardown
   * timer still fires and tears them down on schedule, independent of
   * reconnect. `complete: true` makes the batch the server's whole truth for
   * THIS tab on this socket: anything the tab held server-side and did not
   * restate is released (the stale-sub reconciliation).
   */
  private replaySubs(channel: SocketChannel): void {
    const socket = channel === this.channels.central ? "central" : "worktree";
    trace(
      `replaySubs socket=${socket} subCount=${channel.subs.size} epoch=${channel.serverEpoch !== undefined ? 1 : 0}`,
    );
    // Nothing to replay → nothing to send. Replays run on a FRESH socket (the
    // server holds no subs for this tab yet), so an empty `complete` batch
    // would reconcile nothing; skipping keeps the wire quiet, matching the old
    // per-sub behavior.
    if (channel.subs.size === 0) {
      this.emitDebug();
      return;
    }
    const entries: Array<{
      id: number;
      key: string;
      params: ResourceParams;
      etag?: string;
      version?: number;
      acks?: true;
    }> = [];
    // Counted, not traced per sub: a replay carries the tab's whole set (hundreds
    // of subs), and the always-on channel logs transitions, not per-item lines.
    let unbacked = 0;
    for (const sub of channel.subs.values()) {
      // Can we still back a freshness claim with the value it describes? A
      // gc'd cache entry (or one that never applied) makes both the version and
      // the etag lies that the server would answer `up-to-date` to — see the
      // doc comment above.
      const backed = this.hasAppliedValue(sub.key, sub.params);
      // Capture the version BEFORE the baseline reset — it names the state the
      // cached value was produced under, which is exactly what the server's
      // short-circuit compares. The reset itself keeps the apply-lower-version
      // semantics a post-restart full sub-ack depends on (H2).
      const knownVersion = sub.version;
      sub.version = -1;
      // A replay asks for full values: a derivation still in flight is no
      // longer this sub's question (its answer died with the old socket).
      sub.derivation = undefined;
      // The next ack is the fresh baseline. Clear it so a stale pre-resync ack
      // can't be read as the resync's (liveFrameSeq is a monotonic counter and
      // is never reset).
      sub.lastAckVersion = -1;
      const id = this.nextMsgId++;
      this.markAwaiting(channel, sub, id);
      if (!backed) unbacked++;
      entries.push({
        id,
        key: sub.key,
        params: sub.params,
        ...(backed && sub.etag !== undefined ? { etag: sub.etag } : {}),
        ...(backed && knownVersion >= 0 ? { version: knownVersion } : {}),
        ...(this.wantsAcks(channel, `${sub.key}\0${paramsKey(sub.params)}`)
          ? { acks: true as const }
          : {}),
      });
    }
    channel.ws.send(
      wire({
        op: "sub-batch",
        tabId: this.tabId,
        build: clientBuild(),
        protocol: PROTOCOL,
        ...(channel.serverEpoch !== undefined
          ? { epoch: channel.serverEpoch }
          : {}),
        complete: true,
        entries,
      }),
    );
    if (unbacked > 0)
      trace(
        `replaySubs socket=${socket} unbacked=${unbacked}/${entries.length}`,
      );
    this.armUnansweredCheck(channel);
    this.emitDebug();
  }

  /**
   * Start this sub's answer deadline for request `id` — only on an OPEN
   * socket: a frame sent while connecting waits in the transport and is resent
   * by the replay on open, which restarts the clock; a socket that never opens
   * is the socket-down watchdog's to report, not this one's.
   */
  private markAwaiting(
    channel: SocketChannel,
    sub: ActiveSub,
    id: number,
  ): void {
    if (channel.ws.connection === null) {
      sub.awaiting = undefined;
      return;
    }
    sub.awaiting = { id, since: Date.now() };
  }

  /**
   * An answer frame (`sub-ack` / `up-to-date` / `sub-error`) reached a tab
   * holding `entry`: stop its deadline when the frame answers the request it
   * awaits — before any gate decides whether its payload applies, since a
   * dropped answer (stale version, another derivation) is still an answer.
   */
  private noteAnswered(
    entry: ActiveSub,
    answer: { id?: number; tabId?: string },
  ): void {
    if (
      entry.awaiting !== undefined &&
      answer.tabId === this.tabId &&
      answer.id === entry.awaiting.id
    )
      entry.awaiting = undefined;
  }

  /**
   * One armed timeout per channel, due when its oldest awaiting sub crosses
   * `UNANSWERED_SUB_MS` — armed only while some sub awaits, so an idle channel
   * holds no timer (no polling). On firing, every sub past the deadline is
   * reported ONCE, as one batch, and stops awaiting; the timer re-arms for the
   * rest.
   */
  private armUnansweredCheck(channel: SocketChannel): void {
    if (channel.unansweredTimer !== undefined) return;
    let oldest: number | undefined;
    for (const sub of channel.subs.values()) {
      if (sub.awaiting === undefined) continue;
      if (oldest === undefined || sub.awaiting.since < oldest)
        oldest = sub.awaiting.since;
    }
    if (oldest === undefined) return;
    channel.unansweredTimer = setTimeout(
      () => {
        channel.unansweredTimer = undefined;
        this.reportUnanswered(channel);
        this.armUnansweredCheck(channel);
      },
      Math.max(0, oldest + UNANSWERED_SUB_MS - Date.now()),
    );
  }

  private reportUnanswered(channel: SocketChannel): void {
    const now = Date.now();
    const open = channel.ws.connection !== null;
    const late: ActiveSub[] = [];
    for (const sub of channel.subs.values()) {
      if (sub.awaiting === undefined) continue;
      // The socket dropped since: the replay on its next open re-sends and
      // restarts the clock, so these are not unanswered on this connection.
      if (!open) sub.awaiting = undefined;
      else if (now - sub.awaiting.since >= UNANSWERED_SUB_MS) late.push(sub);
    }
    if (late.length === 0) return;
    late.sort((a, b) => a.awaiting!.since - b.awaiting!.since);
    const oldest = late[0]!;
    const socket = channel === this.channels.central ? "central" : "worktree";
    const oldestWaitMs = now - oldest.awaiting!.since;
    for (const sub of late) sub.awaiting = undefined;
    trace(
      `unanswered socket=${socket} count=${late.length} oldestKey=${oldest.key} oldestParams=${paramsKey(oldest.params)} waitMs=${oldestWaitMs} tabs=${channel.ws.attachedTabs ?? "?"} conn=${channel.ws.connection ?? "-"}`,
    );
    unansweredSubReportSink.emit({
      socket,
      count: late.length,
      oldestKey: oldest.key,
      oldestParams: paramsKey(oldest.params),
      oldestWaitMs,
      attachedTabs: channel.ws.attachedTabs,
      connection: channel.ws.connection,
    });
  }

  private sendSub(
    channel: SocketChannel,
    key: string,
    params: ResourceParams,
    derive?: DerivationFrame,
  ): void {
    const socket = channel === this.channels.central ? "central" : "worktree";
    // Attach the sub's last-known ETag (if any) so the server can answer
    // `up-to-date` instead of re-running the loader. Read off the live sub entry
    // so every caller (fresh observe with no etag, delta-recovery resub that
    // cleared it) sends the right thing. Single subs never echo a version —
    // a fresh observe has no baseline and a recovery resub must NOT have one
    // (see forceFullResub); the version echo lives in the replay batch.
    //
    // Same backing rule as the replay batch: an etag we cannot back with a
    // cached value would buy an `up-to-date` that carries none. A resurrected
    // keep-alive sub whose query was gc'd is the reachable case (SUB_KEEPALIVE_MS
    // is shorter than React Query's gcTime today, so it is narrow — but the
    // invariant should hold by construction, not by that margin).
    const sub = channel.subs.get(`${key}\0${paramsKey(params)}`);
    const etag =
      sub !== undefined && this.hasAppliedValue(key, params)
        ? sub.etag
        : undefined;
    const id = this.nextMsgId++;
    if (sub !== undefined) {
      this.markAwaiting(channel, sub, id);
      this.armUnansweredCheck(channel);
    }
    trace(
      `sendSub key=${key} params=${paramsKey(params)} socket=${socket}${etag !== undefined ? " etag=1" : ""}${derive !== undefined ? ` derive=${derive.from.length}` : ""}`,
    );
    channel.ws.send(
      wire({
        op: "sub",
        id,
        key,
        params,
        ...(etag !== undefined ? { etag } : {}),
        // A fresh sub only (`observe`): seeded from rows this tab holds.
        ...(derive !== undefined ? { derive } : {}),
        // Restated on every sub (fresh, recovery): the server takes the frame
        // as this tab's whole statement for the tuple, flag included.
        ...(this.wantsAcks(channel, `${key}\0${paramsKey(params)}`)
          ? { acks: true }
          : {}),
        tabId: this.tabId,
        // Per frame: one shared socket carries every tab's frames, and their
        // bundles may differ (see `clientBuild`).
        build: clientBuild(),
        // The vocabulary this tab reads: the server trusts a `derive` only
        // under its own.
        protocol: PROTOCOL,
      }),
    );
  }

  /**
   * Force a FULL resubscribe for a sub whose cached base is unusable (a delta
   * with no base, or drift — `order` named ids we cannot resolve). Clears the
   * stored etag AND resets the version baselines BEFORE sending a version-less,
   * etag-less sub, so the recovery answer is always a full sub-ack and it
   * always APPLIES. The baseline reset is load-bearing: `handleServerMessage`
   * adopts a frame's version before dispatching, so the broken delta already
   * advanced `entry.version` to the server's current version — without the
   * reset, the recovery sub-ack (same version) would be dropped by the `<=`
   * guard and the cache would never heal until an unrelated bump.
   */
  private forceFullResub(
    channel: SocketChannel,
    entry: ActiveSub,
    key: string,
    params: ResourceParams,
  ): void {
    entry.etag = undefined;
    entry.version = -1;
    entry.lastAckVersion = -1;
    entry.derivation = undefined;
    entry.wire = undefined;
    this.sendSub(channel, key, params);
  }

  /**
   * `receivedAt`: wall-clock epoch ms the frame reached this tab (stamped by
   * `onmessage` before decoding; defaults to now for a frame handed in
   * directly). Read only to time an update sample.
   */
  private handleServerMessage(
    channel: SocketChannel,
    msg: ServerMsg,
    receivedAt: number = Date.now(),
  ): void {
    if (msg.kind === "ping") {
      // Server keepalive: never answered (per-tab duplicate `pong`s would be N×
      // writes through the shared socket for nothing). It does carry the server's
      // flush age, which the health report reads as "live updates stuck".
      this.noteServerFlushOpenMs(
        channel === this.channels.central ? "central" : "worktree",
        msg.flushOpenMs,
      );
      return;
    }
    if (msg.kind === "sub-error") {
      const pk = paramsKey(msg.params);
      const verdictTag =
        msg.verdict !== undefined ? ` verdict=${msg.verdict}` : "";
      // A skewed contract is the expected face of a deploy under an open tab —
      // the Reload advice says so; it is not a console error. Nor is a refusal:
      // the server answered the question, with "cannot be asked like that".
      if (msg.reason === "refused") {
        console.info(
          `[notifications] sub-error key=${msg.key} reason=refused code=${msg.code ?? ""}: ${msg.message ?? ""}`,
        );
      } else if (msg.verdict === "skew") {
        console.warn(
          `[notifications] sub-error key=${msg.key} reason=${msg.reason}${verdictTag}`,
        );
      } else {
        console.error(
          `[notifications] sub-error key=${msg.key} reason=${msg.reason}${verdictTag}`,
        );
      }
      trace(
        `sub-error key=${msg.key} params=${pk} reason=${msg.reason}${verdictTag}`,
      );
      // Gate on the local sub entry exactly like every other frame: the shared
      // socket broadcasts to every tab, and a pre-upgrade server's params-less
      // frame (`msg.params` undefined) won't match a live sub → safe drop. When
      // this tab DOES hold the sub, run the HTTP fallback read — its own
      // outcome sets q.error naturally (500 loader-failed / 404 →
      // ResourceHttpError) or heals if transient — instead of leaving the
      // resource wedged `pending` forever with `error: null`.
      // NOTE: handleResourceHttp runs no `authorize` check today; moot with zero
      // authorize resources, a follow-up composes with this invalidate flow when
      // the authorize seam ships.
      const entry = channel.subs.get(`${msg.key}\0${pk}`);
      if (!entry) {
        trace(
          `drop key=${msg.key} params=${pk} reason=no-sub source=sub-error`,
        );
        return;
      }
      this.noteAnswered(entry, msg);
      // Mark the store first (a contract refusal means this bundle is out of
      // date), then heal through the one error channel: the HTTP read now gets
      // the typed 409/404 body, so `q.error` names the reason.
      noteContractRefusal(msg.key, msg.reason, msg.verdict);
      entry.derivation = undefined;
      this.fetchAfterSubError(channel, msg.key, msg.params);
      return;
    }
    if (msg.kind === "ack") {
      // Standalone mutation-ack frame: version-less and cache-less, so it must
      // be handled BEFORE the version-guard block below (it carries no version
      // to compare). Gated on the local sub entry exactly like `sub-error`
      // (the shared socket broadcasts every frame to every tab). Notes the acks
      // into the module registry — which fires the registry's subscribers after
      // noting — and does NOTHING else: no cache write, no markApplied, no
      // version/epoch adoption.
      const pk = paramsKey(msg.params);
      const entry = channel.subs.get(`${msg.key}\0${pk}`);
      if (!entry) {
        trace(`drop key=${msg.key} params=${pk} reason=no-sub source=ack`);
        return;
      }
      this.registries.txAcks.note(msg.key, msg.params, msg.ackTx);
      return;
    }
    // Learn the server's boot epoch from any ack frame carrying one — BEFORE the
    // per-sub gates below, since the epoch is channel-level server identity (an
    // ack for another tab's sub teaches it just as well). The next replay echoes
    // it alongside each sub's version so a same-boot server can short-circuit.
    if (
      (msg.kind === "sub-ack" ||
        msg.kind === "up-to-date" ||
        msg.kind === "up-to-date-batch") &&
      msg.epoch !== undefined
    ) {
      channel.serverEpoch = msg.epoch;
    }
    if (msg.kind === "up-to-date-batch") {
      // The batched replay answer: run each entry through the exact per-entry
      // `up-to-date` logic (no-sub gate, version guard, adoption, lastAckVersion).
      for (const e of msg.entries) {
        this.handleServerMessage(channel, {
          kind: "up-to-date",
          id: e.id,
          tabId: msg.tabId,
          key: e.key,
          params: e.params,
          version: e.version,
          epoch: msg.epoch,
        });
      }
      return;
    }

    // Every remaining kind (sub-ack/update/delta/invalidate) carries (key,
    // params) and targets a subscription. The shared socket broadcasts *every*
    // server frame to *every* tab (see SharedWebSocket) — so this tab also
    // receives frames for subscriptions only other tabs made. Apply a frame
    // only when THIS tab holds a live subscription for it: a present `entry`
    // means observe() ran here, which registered the schema/keyOf the apply*
    // methods rely on. Without this gate a frame for another tab's resource
    // reaches applyUpdate with no schema registered and throws. The version
    // guard + bump also live here, deduped across all three apply paths.
    const pk = paramsKey(msg.params);
    const id = `${msg.key}\0${pk}`;
    const entry = channel.subs.get(id);
    if (!entry) {
      trace(
        `drop key=${msg.key} params=${pk} version=${msg.version} reason=no-sub`,
      );
      return;
    }
    if (msg.kind === "sub-ack" || msg.kind === "up-to-date")
      this.noteAnswered(entry, msg);
    if (msg.version <= entry.version) {
      trace(
        `drop key=${msg.key} params=${pk} msgVersion=${msg.version} haveVersion=${entry.version} reason=stale-version`,
      );
      return;
    }
    // A patch applies only to the value it was made against: the wire value
    // this tab holds at `base`. Any other (a frame lost, a value read over
    // HTTP, nothing yet) is a base the patch cannot build on — reload it whole,
    // before the version below is adopted.
    const patchBase = msg.kind === "patch" ? entry.wire : undefined;
    if (
      msg.kind === "patch" &&
      (entry.version !== msg.base ||
        patchBase === undefined ||
        !this.hasAppliedValue(msg.key, msg.params))
    ) {
      trace(
        `drop key=${msg.key} params=${pk} base=${msg.base} haveVersion=${entry.version} reason=patch-base-resub`,
      );
      this.forceFullResub(channel, entry, msg.key, msg.params);
      return;
    }
    // THE INVARIANT: `entry.version` names the version of a value THIS tab
    // actually holds. A value-less `up-to-date` says "what you have is still
    // current" — meaningless, and actively destructive, when we have nothing.
    //
    // The shared socket broadcasts EVERY frame to EVERY tab, and the gate above
    // is only "do I hold a sub for this (key, params)", never "was this ack
    // answering MY request". So another tab's replay short-circuit
    // (`up-to-date`/`up-to-date-batch`, the only frames the server answers a
    // version echo with) reaches a tab that has an in-flight first sub and an
    // empty cache. Adopting its version there poisons the guard above: our own
    // value-carrying `sub-ack` arrives at the SAME version and is dropped as
    // stale — and for a resource whose version rarely moves (a config doc sits
    // at 0 until its file changes) nothing ever exceeds it again, so the query
    // stays `pending` forever and `useConfig` serves `descriptor.defaults`. That
    // is the "No views configured" wedge that only a page reload cured.
    //
    // Ignore, don't resub: the entry exists because THIS tab sent a sub, so its
    // answer is already in flight and will apply against our untouched -1
    // baseline. A resub would add load to the congested server that widened the
    // race in the first place. This is the WS twin of `fetchOverHttp`'s
    // never-settle-unvouched rule (same `hasAppliedValue` predicate).
    if (
      msg.kind === "up-to-date" &&
      !this.hasAppliedValue(msg.key, msg.params)
    ) {
      trace(
        `drop key=${msg.key} params=${pk} version=${msg.version} reason=no-applied-value`,
      );
      return;
    }
    // A DERIVED sub-ack carries no value: it says "the rows your derivation
    // named are this tuple's value". The same invariant as above — only a tab
    // that holds exactly those rows may adopt its version: the one whose
    // in-flight derivation's id it echoes. Any other tab holding the tuple (it
    // subscribed plainly, asked another derivation, or reset this one by a
    // replay, a forced resub or a sub-error) ignores it; its own answer is in
    // flight against its untouched baseline.
    if (
      msg.kind === "sub-ack" &&
      "derived" in msg &&
      entry.derivation?.id !== msg.derived.id
    ) {
      trace(
        `drop key=${msg.key} params=${pk} version=${msg.version} reason=not-our-derivation`,
      );
      return;
    }
    if (msg.kind === "sub-ack") {
      trace(`sub-ack key=${msg.key} params=${pk} version=${msg.version}`);
    } else if (msg.kind === "up-to-date") {
      trace(`up-to-date key=${msg.key} params=${pk} version=${msg.version}`);
    }
    entry.version = msg.version;
    // Split the two causes of a version advance so the wedge probe can tell them
    // apart: a sub-ack (and its `up-to-date` sibling) carries server truth at
    // (re)subscribe; every other kind is a live, server-initiated frame.
    if (msg.kind === "sub-ack" || msg.kind === "up-to-date") {
      entry.lastAckVersion = msg.version;
      // Stamp which server boot `entry.version` now belongs to. Only ack frames
      // carry `epoch` (sub-ack, and up-to-date — incl. the up-to-date-batch that
      // recurses through it with the batch epoch attached); update/delta/
      // invalidate ride the same boot's stream and leave `entry.epoch` unchanged.
      // This is what lets `fetchOverHttp`'s guard compare an HTTP body cross-boot.
      if (msg.epoch !== undefined) entry.epoch = msg.epoch;
    } else {
      entry.liveFrameSeq++;
    }
    // Store the fresh ETag from any full-value frame that carries one, so the next
    // (re)subscribe / conditional GET can be answered `up-to-date`/304.
    if (
      (msg.kind === "sub-ack" || msg.kind === "update") &&
      "etag" in msg &&
      msg.etag !== undefined
    ) {
      entry.etag = msg.etag;
    }

    if (msg.kind === "up-to-date") {
      // Conditional-revalidation hit: the server confirmed our cached value is
      // still current. Do NOT touch the TanStack cache — the cached value stays.
      // We already adopted `version`/`lastAckVersion` above (so a later real
      // update isn't stale-dropped and the missed-update watchdog sees a clean
      // ack) and kept the stored etag. A failure the query still carries is
      // no longer true of the value it holds, so it clears (the sticky-error
      // fix); then fire the debug hook.
      this.clearStaleError(msg.key, msg.params);
      this.emitDebug();
      return;
    }

    if (msg.kind === "sub-ack" && "derived" in msg) {
      this.applyDerived(entry, msg.key, msg.params);
      return;
    }
    // A bytes value's sub-ack carries no value (an ArrayBuffer never rides a
    // JSON frame): it opened the tuple's tracking span — version and epoch are
    // adopted above — and the value is read over HTTP now, so it is no older
    // than the span (an in-flight mount read is superseded, never applied
    // twice). Its `update` never comes: a bytes value is invalidate-only.
    if (msg.kind === "sub-ack" && this.reads.get(msg.key)?.bytes === true) {
      this.applyInvalidate(msg.key, msg.params);
      return;
    }
    if (msg.kind === "sub-ack" && !("value" in msg)) {
      // Only a bytes read's sub-ack carries no value (handled above): one for
      // any other read is a server bug, never an `undefined` to cache.
      throw new Error(
        `live-state: a value-less sub-ack for non-bytes resource ${msg.key}`,
      );
    }
    if (msg.kind === "sub-ack" || msg.kind === "update") {
      // A value-carrying sub-ack answers a derivation too: the server loaded.
      if (msg.kind === "sub-ack") entry.derivation = undefined;
      this.applyUpdate(
        entry,
        msg.key,
        msg.params,
        msg.value,
        msg.watermark,
        msg.kind === "update" ? msg.ackTx : undefined,
      );
      if (msg.kind === "update")
        this.reportUpdateLatency(msg.key, msg.params, msg.timing, receivedAt);
      return;
    }
    if (msg.kind === "patch" && patchBase !== undefined) {
      // The base check above passed: `patchBase` is the value at `msg.base`.
      const next = applyValuePatch(patchBase.value, msg.ops);
      this.applyUpdate(
        entry,
        msg.key,
        msg.params,
        next,
        msg.watermark,
        msg.ackTx,
      );
      this.reportUpdateLatency(msg.key, msg.params, msg.timing, receivedAt);
      return;
    }
    if (msg.kind === "delta") {
      const outcome = this.applyDelta(
        channel,
        entry,
        msg.key,
        msg.params,
        msg.upserts,
        msg.order,
        msg.watermark,
        msg.ackTx,
      );
      // A delta that dead-ended in a forced resubscribe wrote nothing: the
      // value its change stands behind reaches this tab only with the
      // recovery sub-ack, which carries no timing.
      if (outcome === "applied")
        this.reportUpdateLatency(msg.key, msg.params, msg.timing, receivedAt);
      return;
    }
    // Only remaining case: "invalidate"
    this.applyInvalidate(msg.key, msg.params);
  }

  /**
   * The `update` latency sample — server change → value written into THIS
   * tab's cache — for every applied pushed frame a change stands behind (one
   * carrying `timing`; every other frame — sub-ack, replay, a forced
   * resubscribe's answer — has none, so it times nothing). Runs AFTER the cache
   * write, so the clock stops once the value is in the tab's hands (written,
   * not painted). Only this tab's live subs reach here (the no-sub gate), so
   * every tab reports its own samples, a background one flagged `hidden`. No
   * work at all while nobody listens.
   */
  private reportUpdateLatency(
    key: string,
    params: ResourceParams,
    timing: FrameTiming | undefined,
    receivedAt: number,
  ): void {
    if (
      timing === undefined ||
      !this.telemetry ||
      !clientLatencySink.hasSubscribers()
    )
      return;
    const appliedAt = Date.now();
    const { changedAt, sentAt, deliverMs } = timing;
    clientLatencySink.emit({
      signal: "update",
      key,
      params,
      phases: splitPhases("update", {
        "server-notice": sentAt - deliverMs - changedAt,
        "server-deliver": deliverMs,
        // The one phase across two clocks (server send → browser receipt).
        transport: receivedAt - sentAt,
        "client-apply": appliedAt - receivedAt,
      }),
      totalMs: appliedAt - changedAt,
      hidden: this.isHiddenSince(changedAt),
    });
  }

  /**
   * The page is hidden now, or was at any instant since `since` (wall-clock
   * epoch ms): a background tab's timers and frames are throttled, so a span
   * that overlaps one measures the browser, not the system.
   */
  private isHiddenSince(since: number): boolean {
    if (document.visibilityState === "hidden") return true;
    return this.lastHiddenAt !== null && this.lastHiddenAt >= since;
  }

  private applyUpdate(
    entry: ActiveSub,
    key: string,
    params: ResourceParams,
    value: unknown,
    watermark?: string,
    ackTx?: readonly string[],
  ): void {
    // Invariant: handleServerMessage only reaches here for a (key) this tab
    // observes, and observe() registers the schema alongside the sub entry — so
    // a missing schema means that contract was violated.
    const schema = this.reads.get(key)?.schema;
    if (!schema) {
      throw new Error(
        `[notifications] no schema registered for key="${key}". ` +
          `useResource must observe the descriptor (which carries the schema) ` +
          `before any update can be applied.`,
      );
    }
    const parsed = schema.parse(value);
    // A patched read keeps the wire value: the next patch applies to it.
    entry.wire = this.reads.get(key)?.patches === true ? { value } : undefined;
    // Adopt the frame's commit watermark — and note its mutation acks —
    // IMMEDIATELY BEFORE the cache write they describe (load-bearing order:
    // QueryCache listeners — the optimistic hook's confirm pass — read the
    // registries synchronously inside setQueryData dispatch). After the parse,
    // so a frame that never lands (schema throw) never advances the causal
    // floor / acks past the cache content.
    if (watermark !== undefined)
      this.registries.watermarks.note(key, params, watermark);
    if (ackTx !== undefined && ackTx.length > 0)
      this.registries.txAcks.note(key, params, ackTx);
    this.queryClient.setQueryData(queryKeyFor(key, params), parsed);
    entry.socketValue = true;
    this.markApplied(entry, key);
  }

  /**
   * Adopt the rows this sub's derivation named as its value — the answer to
   * it was checked to be ours (`handleServerMessage`). They are rows this tab
   * already parsed (the sources' cached rows, same objects), so no parse; and
   * no watermark or acks ride a derived ack.
   */
  private applyDerived(
    entry: ActiveSub,
    key: string,
    params: ResourceParams,
  ): void {
    const rows = entry.derivation!.rows;
    entry.derivation = undefined;
    trace(
      `derived key=${key} params=${paramsKey(params)} version=${entry.version} rows=${rows.length}`,
    );
    this.queryClient.setQueryData(queryKeyFor(key, params), [...rows]);
    entry.socketValue = true;
    this.markApplied(entry, key);
  }

  /** Stamp the apply time, fire debug listeners, and emit the verbose-gated apply
   *  trace. Covers WS applies (applyUpdate/applyDelta) and the HTTP apply
   *  (fetchOverHttp), so it is the single place the consecutive stale-drop counter
   *  is reset on a successful apply. */
  private markApplied(entry: ActiveSub, key: string): void {
    entry.lastAppliedAt = Date.now();
    entry.appliedSeq = ++this.applySeq;
    this.staleDropCounts.delete(`${key}\0${paramsKey(entry.params)}`);
    if (verboseTraceOn()) {
      trace(
        `applyUpdate key=${key} params=${paramsKey(entry.params)} version=${entry.version}`,
      );
    }
    this.emitDebug();
  }

  // Merge a row-keyed delta into the cached array. Unchanged rows keep their
  // identical object reference (reused from the prior value via `existingById`),
  // so memoized row components don't re-render — only changed rows get new
  // objects. The new array order is authoritative from the server's `order`.
  // `deletes` is not a parameter: the new array is rebuilt purely from `order`
  // (the authoritative final id list), so deleted ids are implicitly excluded.
  // The server still ships `deletes` on the wire for clarity and Layer 2 reuse.
  private applyDelta(
    channel: SocketChannel,
    entry: ActiveSub,
    key: string,
    params: ResourceParams,
    upserts: readonly (readonly [string, unknown])[],
    order: readonly string[] | undefined,
    watermark?: string,
    ackTx?: readonly string[],
  ): "applied" | "resubscribed" {
    const queryKey = queryKeyFor(key, params);
    // Base-presence guard (load-bearing): never apply a delta onto a missing
    // base. If the cache holds no server-vouched value yet, force a fresh full
    // snapshot — a scoped delta (no `order`) merged onto nothing would settle
    // the read on a false partial list, and adopting this delta's version
    // would then drop the tab's own sub-ack as stale. It happens whenever
    // another tab's subscription on the shared socket draws a delta before
    // this tab's sub-ack lands.
    if (!this.hasAppliedValue(key, params)) {
      trace(
        `applyDelta key=${key} params=${paramsKey(params)} reason=delta-no-base-resub`,
      );
      // The cached base is gone — recovery must reload a full base, and its
      // sub-ack must APPLY even at the version this very delta already advanced
      // us to (see forceFullResub: etag cleared + baselines reset).
      this.forceFullResub(channel, entry, key, params);
      return "resubscribed";
    }
    const schema = this.reads.get(key)?.schema;
    if (!schema) {
      throw new Error(
        `[notifications] no schema registered for key="${key}". ` +
          `useResource must observe the descriptor (which carries the schema) ` +
          `before any update can be applied.`,
      );
    }
    const keyOf = this.keyedKeyOf.get(key);
    if (!keyOf) {
      throw new Error(
        `[notifications] no keyOf registered for keyed resource key="${key}". ` +
          `Declare it with liveCollection (its descriptors carry keyOf) so ` +
          `observe() registers the row identity.`,
      );
    }
    // Parse each upsert row individually via the array schema's element — never
    // re-parse the whole array (that's the cost this protocol removes).
    // biome-ignore lint/suspicious/noExplicitAny: zod array schemas expose `.element`.
    const element = (schema as any).element as ZodParser<unknown>;
    const upsertMap = new Map<string, unknown>();
    for (const [rowId, row] of upserts)
      upsertMap.set(rowId, element.parse(row));

    // The base-presence guard above already ensured a non-undefined base.
    const prevRows =
      (this.queryClient.getQueryData(queryKey) as unknown[]) ?? [];
    const result = mergeKeyedDelta(prevRows, upsertMap, order, keyOf);
    if (result.kind === "drift") {
      // `order` named ids resolvable from neither the upserts nor the cached
      // base — the client's base has drifted behind the server snapshot (a
      // missed/stale-dropped intermediate frame). Writing the rebuild anyway
      // would punch `undefined` holes into the array and crash the next
      // consumer to iterate the rows; instead leave the cache untouched and
      // force a fresh full base.
      trace(
        `applyDelta key=${key} params=${paramsKey(params)} reason=delta-drift-resub ids=${result.missingIds.join(",")}`,
      );
      // Base drifted behind server truth — recovery reloads a full base (etag
      // cleared so it's never told `up-to-date`) and its sub-ack applies even
      // at this delta's own version (baselines reset — see forceFullResub).
      this.forceFullResub(channel, entry, key, params);
      return "resubscribed";
    }
    // Adopt the FULL delta's commit watermark — and note the delta's mutation
    // acks — IMMEDIATELY BEFORE the cache write they describe (same load-bearing
    // order as applyUpdate). After the merge succeeded, so a delta that
    // dead-ends in a forced resub (no-base / drift above) never advances the
    // causal floor OR the acks past the cache content — the recovery sub-ack
    // brings its own watermark with its own full value. Scoped deltas arrive
    // watermark-less by construction (Rule B′) but DO carry ackTx: the ack
    // claims only "these transactions' rows were re-read", never snapshot
    // completeness, so it composes with a partial re-read.
    if (watermark !== undefined)
      this.registries.watermarks.note(key, params, watermark);
    if (ackTx !== undefined && ackTx.length > 0)
      this.registries.txAcks.note(key, params, ackTx);
    this.queryClient.setQueryData(queryKey, result.rows);
    entry.socketValue = true;
    this.markApplied(entry, key);
    return "applied";
  }

  private applyInvalidate(key: string, params: ResourceParams): void {
    void this.queryClient.invalidateQueries({
      queryKey: queryKeyFor(key, params),
    });
  }

  /**
   * The sub failed server-side: read the value over HTTP now, whatever the
   * query's `enabled`. Not `invalidateQueries` — it refetches only ENABLED
   * queries, and a pushed query is disabled until its first value
   * (`use-resource.ts`' `enabled` rule), so a first-sub failure would sit
   * `pending` with no error forever.
   * `prefetchQuery` fetches it anyway through the same version-guarded read as
   * the query's own `queryFn`, and never rejects: a failure lands in the
   * query's error state (`q.error`, the one error channel), a success heals it.
   */
  private fetchAfterSubError(
    channel: SocketChannel,
    key: string,
    params: ResourceParams,
  ): void {
    const read = this.reads.get(key);
    if (!read) {
      // A held sub always registered its schema in observe(), with the entry.
      throw new Error(
        `[notifications] no schema registered for key="${key}" on sub-error.`,
      );
    }
    const origin: ResourceOrigin | undefined =
      channel === this.channels.central ? "central" : undefined;
    void this.queryClient.prefetchQuery({
      queryKey: queryKeyFor(key, params),
      queryFn: () => this.fetchOverHttp(key, params, origin, read, "fallback"),
      staleTime: 0,
    });
  }
}

/** A failed response's JSON body, or `undefined` when it has none (an older server's plain text). */
async function readJsonBody(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}
