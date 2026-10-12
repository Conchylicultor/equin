import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  QueryClient,
  QueryClientProvider,
  hashKey,
  skipToken,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryObserverResult,
} from "@tanstack/react-query";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import {
  NotificationsClient,
  isTerminalResourceError,
  queryKeyFor,
} from "./notifications-client";
import { slowResourceReportSink } from "./slow-resource-reporter";
import { notePendingMount } from "./pending-mount-tracker";
import { dateAwareReplaceEqualDeep } from "./internal/structural-sharing";
import { toResourceError } from "./resource-error";
import { queryResult } from "./query-result";
import type {
  ChannelStatuses,
  ResourceDerivation,
} from "./notifications-client";
import { canonicalParams } from "@plugins/packages/plugins/canonical-params/core";
import type { FailingResource } from "./resource-error-reporter";
import type { ResourceDescriptor, ResourceError } from "../core";
import type { WsStatus } from "@plugins/primitives/plugins/networking/web";

type ResourceParams = Record<string, string>;

const NotificationsContext = createContext<NotificationsClient | null>(null);

let defaultClient: QueryClient | null = null;
function getDefaultQueryClient(): QueryClient {
  if (!defaultClient) {
    defaultClient = new QueryClient({
      defaultOptions: {
        queries: {
          // The WS is the source of truth. Disable background refetches; the
          // notifications client keeps cached data in sync.
          staleTime: Infinity,
          refetchOnWindowFocus: false,
          refetchOnReconnect: false,
          // One retry for a transient failure — never for a contract refusal
          // (`contract-mismatch` / `unknown-key`): the same bundle sends the
          // same params and is refused the same way; the Reload advice is the
          // remedy, not another request.
          retry: (failureCount, error) =>
            failureCount < 1 && !isTerminalResourceError(error),
        },
      },
    });
  }
  return defaultClient;
}

export interface NotificationsProviderProps {
  children: ReactNode;
  queryClient?: QueryClient;
}

export function NotificationsProvider({
  children,
  queryClient,
}: NotificationsProviderProps) {
  const qc = queryClient ?? getDefaultQueryClient();
  // NotificationsClient is a singleton for the tab; create on first render.
  const notifications = getOrCreateNotifications(qc);
  return createElement(
    QueryClientProvider,
    { client: qc },
    createElement(
      NotificationsContext.Provider,
      { value: notifications },
      children,
    ),
  );
}

let singleton: NotificationsClient | null = null;
function getOrCreateNotifications(qc: QueryClient): NotificationsClient {
  if (!singleton) singleton = new NotificationsClient(qc);
  return singleton;
}

// Transport hoist: construct the singleton NotificationsClient at the VERY start
// of boot — before any plugin chunk is evaluated — so its leader-election
// `navigator.locks.request` is queued at t≈0. The lock grant callback (which
// calls `new WebSocket()` inside SharedWebSocket) then fires during the first
// main-thread yield (a `loadPlugins` await gap) and the socket opens *during*
// boot instead of ~8s later, after the full app mount. NotificationsProvider
// later calls the same `getOrCreateNotifications`, so it reuses THIS singleton —
// the one-socket-per-origin invariant is preserved (no eager second socket, no
// per-tab WS regression). Constructed against the same default QueryClient the
// provider mounts, so seeded/hydrated cache entries line up.
export function ensureNotificationsClient(): NotificationsClient {
  return getOrCreateNotifications(getDefaultQueryClient());
}

// Context-free accessor for the singleton — usable from Core.Root watchers that
// may mount outside NotificationsProvider (the wedge watchdog). Returns null
// until the provider has created the client (i.e. before first render).
export function getNotificationsClient(): NotificationsClient | null {
  return singleton;
}

export function useNotificationsStatus(): WsStatus {
  const client = useContext(NotificationsContext);
  if (!client)
    throw new Error(
      "useNotificationsStatus must be inside NotificationsProvider",
    );
  const [status, setStatus] = useState(() => client.getStatus());
  useEffect(() => client.subscribeStatus(setStatus), [client]);
  return status;
}

export function useNotificationsChannelStatuses(): ChannelStatuses {
  const client = useContext(NotificationsContext);
  if (!client)
    throw new Error(
      "useNotificationsChannelStatuses must be inside NotificationsProvider",
    );
  const [statuses, setStatuses] = useState(() => client.getChannelStatuses());
  useEffect(() => client.subscribeChannelStatuses(setStatuses), [client]);
  return statuses;
}

/**
 * Every live read on this page currently failing — one entry per
 * `(key, params)` tuple, however many hooks observe it. The health report's
 * "resources failing" row reads it; it empties as reads recover (a push, a
 * retry, the `up-to-date` clear).
 */
export function useFailingResources(): readonly FailingResource[] {
  const client = useContext(NotificationsContext);
  if (!client)
    throw new Error("useFailingResources must be inside NotificationsProvider");
  return useSyncExternalStore(
    (fn) => client.subscribeFailingResources(fn),
    () => client.getFailingResources(),
    () => client.getFailingResources(),
  );
}

// Accessor for the singleton NotificationsClient — consumers (the live-state
// health pane, the wedge watchdog) use it to reach probeMissedUpdates()/
// debugSnapshot()/subscribeDebug(). Must be called inside NotificationsProvider.
export function useNotificationsClient(): NotificationsClient {
  const client = useContext(NotificationsContext);
  if (!client)
    throw new Error(
      "useNotificationsClient must be inside NotificationsProvider",
    );
  return client;
}

// Seed the default query client's cache for a resource before any component
// observes it. Used at boot (the boot snapshot) so the first render reads real
// data synchronously instead of `pending` — no flash, no Suspense. Writes the
// SAME default client NotificationsProvider uses (no `queryClient` prop) via the
// SAME queryKeyFor (over the same canonical params) consumers use, so a later
// useResource adopts the seeded entry (its non-zero dataUpdatedAt makes
// `pending` false immediately). The schema registry (NotificationsClient) is
// untouched — only applyUpdate reads it, and that fires only after a mounted
// useResource calls observe(), which registers the schema first.
//
// A `"boot-and-keep"` key is made resident HERE, before the query exists:
// `setQueryData` builds the query with the client's defaults, and its
// constructor arms the GC timer (5 min) — so `useResource`'s own `gcTime:
// Infinity` (applied only once an observer mounts) would come too late for a
// tuple nobody opens within 5 minutes of boot. A query default registered on
// the key prefix `[key]` reaches every tuple of the key as it is built.
export function hydrateResource<T, P extends ResourceParams = ResourceParams>(
  resource: ResourceDescriptor<T, P>,
  params: P | undefined,
  value: unknown,
): void {
  const parsed = resource.schema.parse(value);
  const client = getDefaultQueryClient();
  if (resource.preload === "boot-and-keep") {
    client.setQueryDefaults([resource.key], { gcTime: Infinity });
  }
  client.setQueryData(
    queryKeyFor(
      resource.key,
      params && canonicalParams(params, resource.optionalParams),
    ),
    parsed,
  );
}

// Seed an arbitrary query on the app's default QueryClient before mount — the
// non-resource companion to hydrateResource, for boot tasks that pre-fetch
// plain query data (e.g. endpoints' hydrateEndpoint). The caller owns the key
// shape; this only guarantees the write lands on the SAME client the app's
// QueryClientProvider mounts.
export function hydrateQuery(queryKey: unknown[], data: unknown): void {
  getDefaultQueryClient().setQueryData(queryKey, data);
}

/**
 * Ask for standalone ack frames on (resource, params) for as long as the
 * calling component is mounted — see `NotificationsClient.requestAcks`. For a
 * reader holding optimistic ops whose writes may change nothing it can see
 * (a reorder that only moved other rows, a net-zero write): the server then
 * confirms each such write with a version-less `{ kind: "ack" }` frame instead
 * of shipping nothing. Pair it with a `useResource` on the same tuple.
 */
export function useResourceAcks<P extends ResourceParams = ResourceParams>(
  resource: Pick<
    ResourceDescriptor<unknown, P>,
    "key" | "origin" | "optionalParams"
  >,
  params?: P,
): void {
  const notifications = useContext(NotificationsContext);
  if (!notifications) {
    throw new Error(
      "useResourceAcks must be used within a NotificationsProvider",
    );
  }
  const { key, origin } = resource;
  // The same canonical tuple `useResource` subscribes — see `canonicalParams`.
  const paramsJson = JSON.stringify(
    canonicalParams(params ?? {}, resource.optionalParams),
  );
  useEffect(
    () =>
      notifications.requestAcks(
        key,
        JSON.parse(paramsJson) as ResourceParams,
        origin,
      ),
    [notifications, key, origin, paramsJson],
  );
}

// A read is in exactly one of three states, named by `status` (see
// `../core/resource-status.ts`):
//
//   loading — no value yet, no failure: render the loading state;
//   error   — the read failed: `error` is a typed, NEVER-null `ResourceError`,
//             and `stale` the last value the server vouched for, if one landed;
//   ready   — `data` is a value the server currently vouches for.
//
// A failure is its own state, never a flavour of loading: a surface that only
// asks "is it loading?" spins forever on a read that will never load. The ready
// arm DELIBERATELY OMITS `error` and `stale`: reading either off a narrowed-ready
// result is a tsc error (a `null`-typed field would catch nothing, since `null`
// is assignable to `Error | null`).
//
// `C` is the refusal codes the read's declaration lists (a `liveValue`'s
// `refusals`): a `refused` error's `code` is one of them. Reads that are never
// refused leave it at `string`.
export type ResourceResult<T, C extends string = string> =
  | {
      status: "loading";
      refetch: () => Promise<void>;
    }
  | {
      status: "error";
      error: ResourceError<C>;
      /** The last value the server vouched for, if one ever landed. */
      stale?: T;
      refetch: () => Promise<void>;
    }
  | {
      status: "ready";
      data: T;
      refetch: () => Promise<void>;
    };

// Optional read options for useResource.
export interface UseResourceOptions<T, S> {
  /**
   * Derive a slice of the resource payload. The component then re-renders
   * **only when the selected slice changes** (React Query runs `replaceEqualDeep`
   * on the select output, so a deeply-equal slice keeps its previous reference
   * and the observer is not notified). This is how a point/derived read of a
   * large list resource — e.g. one row out of `conversations` — avoids the
   * O(C²) re-render storm where every subscriber re-renders on every push.
   *
   * When `select` is set, notifications are scoped to data/error changes
   * (`notifyOnChangeProps`), so the per-push `dataUpdatedAt` bump no longer
   * forces a re-render. Consequence: `pending` flips to `false` silently (no
   * re-render) if the selected slice is identical across the
   * no-value→first-value boundary — a selector that answers `undefined` (a
   * point lookup that finds nothing) — harmless for point lookups, where the
   * caller sees the same value either way.
   *
   * Pass a **stable** selector (`useCallback`) so it is not re-run every render.
   */
  select: (data: T) => S;
  /**
   * Make the `pending` → settled flip reliable for READINESS GATES built on a
   * `select` read. Without it, the flip is silent (no re-render) when the
   * selected slice is identical across the no-value→first-value boundary —
   * the query holds no data before its first value, so a selector answering
   * `undefined` leaves `data` unchanged — harmless for point lookups, fatal for
   * a gate (it can wedge as pending forever). With `gate: true`,
   * notifications stay un-scoped until the tuple's query holds a value, then
   * narrow to the select-scoped ones, so the steady-state re-render behavior
   * is identical to plain `select`.
   * The latch is derived from the cache, so a tuple already cached (a boot
   * hydration) is narrowed from its first render — one render, not two.
   */
  gate?: boolean;
}

/**
 * A gated read whose selector is OPTIONAL (`UseResourceOptions.gate`). Without
 * one, the read is the whole value with no `select` handed to React Query, so
 * `data` IS the cached value — every observer of the tuple holds the same
 * object (and, for an array, the same row objects), never a per-observer
 * structurally-shared copy — while its notifications still narrow to
 * data/error once the tuple holds a value: a push that leaves the cached value
 * unchanged re-renders nothing, and the first value always renders.
 *
 * Its read is typed `ResourceResult<T | S>`: a selector that MAY be absent
 * (`select: cond ? f : undefined`) may hand back the whole `T`, so the type
 * never promises the slice. A selector that is always there is
 * `UseResourceOptions` (`{ select, gate: true }` → `ResourceResult<S>`); with
 * none at all, `S` defaults to `T`.
 */
export interface UseResourceGateOptions<T, S> {
  gate: true;
  select?: ((data: T) => S) | undefined;
}

/**
 * The read's canonical params (`canonicalParams`), `{}` when absent or skipped —
 * one identity per canonical tuple, so every effect keyed on it re-runs only
 * when the tuple does.
 */
function useCanonicalParams(
  params: ResourceParams | null | undefined,
  optional: readonly string[] | undefined,
): ResourceParams {
  const json = JSON.stringify(
    params == null ? {} : canonicalParams(params, optional),
  );
  return useMemo(() => JSON.parse(json) as ResourceParams, [json]);
}

/**
 * The query options of ONE read tuple — shared by `useResource` (its
 * non-skipped arm) and `useResources`, so a tuple read either way is the same
 * query: one key, one HTTP fallback, one enabled rule, one GC rule.
 */
interface TupleQueryOptions<T> {
  queryKey: unknown[];
  queryFn: () => Promise<T>;
  enabled?: (query: { state: { data: unknown } }) => boolean;
  structuralSharing: typeof dateAwareReplaceEqualDeep;
  gcTime?: number;
}
function tupleQueryOptions<T, P extends ResourceParams>(
  notifications: NotificationsClient,
  resource: ResourceDescriptor<T, P>,
  p: ResourceParams,
): TupleQueryOptions<T> {
  const { key, origin } = resource;
  return {
    queryKey: queryKeyFor(key, p),
    // THE single HTTP write path: version-guarded, shared with the cold-start
    // prime (notifications-client.ts `fetchOverHttp`). Runs as the WS-down
    // fallback and the invalidate-mode post-invalidate refetch; the sub-ack
    // normally fills the cache so this rarely runs. Errors propagate to `q.error`.
    queryFn: () =>
      notifications.fetchOverHttp(key, p, origin, resource, "fallback"),
    // Until its first value the query has no data (there is no placeholder),
    // sits at `dataUpdatedAt === 0`, and reads `pending`. React Query would
    // fetch such a query on mount (a query with no data always loads), but the
    // WS sub-ack is what fills the cache — the HTTP `queryFn` is only the
    // fallback — so the query stays disabled until a value lands (then
    // `invalidate` refetches behave as for any other). A manual `refetch()`
    // ignores `enabled`.
    //
    // An on-demand resource is the exception: its value NEVER rides the socket
    // (no sub-ack value, only `invalidate` frames), so HTTP is its read path,
    // not a fallback — it fetches on mount like any enabled query.
    ...(resource.load !== "on-demand"
      ? {
          enabled: (query: { state: { data: unknown } }) =>
            query.state.data !== undefined,
        }
      : {}),
    // Date-aware structural sharing for EVERY resource (with or without
    // `select`): RQ applies the query's `structuralSharing` to both the
    // query-data merge AND the select-result memoization. The default
    // `replaceEqualDeep` treats `Date` instances as opaque (so a deeply-equal
    // payload that carries `z.coerce.date()` fields still mints a new reference
    // on every push), defeating the documented slice-selector dedup. This is
    // strictly stronger dedup, never weaker.
    structuralSharing: dateAwareReplaceEqualDeep,
    // A `"boot-and-keep"` resource is never garbage-collected: its value must
    // survive the windows where nothing observes it, otherwise the next mount
    // reads `dataUpdatedAt === 0` — pending again, long after boot said it was
    // known. A tuple the boot hydrated got the same default before it was built
    // (`hydrateResource`); this covers one a tab subscribes without a hydrate.
    ...(resource.preload === "boot-and-keep" ? { gcTime: Infinity } : {}),
  };
}

/**
 * Report ONE tuple's mount→settle duration (`slowResourceReportSink`), the
 * first time it holds a value — shared by `useResource` and `useResources`, so
 * a tuple read either way is measured alike. live-state stays
 * threshold-agnostic: the registered reporter (a domain plugin) decides what
 * counts as slow. `startedAt` is when the tuple was observed (null: unknown).
 */
function reportTupleSettled(
  notifications: NotificationsClient,
  key: string,
  params: ResourceParams,
  startedAt: number | null,
): void {
  // Cold-start attribution (additive, never suppressing): was the transport
  // NOT yet ready when this tuple mounted, and how much of the settle window
  // did it spend waiting for the transport to first become ready?
  const firstReadyAt = notifications.getFirstReadyAt();
  const now = performance.now();
  slowResourceReportSink.emit({
    key,
    params,
    durationMs: startedAt === null ? 0 : now - startedAt,
    transportColdStart:
      startedAt !== null &&
      (firstReadyAt === null || firstReadyAt >= startedAt),
    transportWaitMs:
      startedAt === null
        ? 0
        : firstReadyAt === null
          ? now - startedAt
          : Math.max(0, Math.min(firstReadyAt, now) - startedAt),
  });
}

/** The subscription of a read with nothing to wait for: no cache listener. */
const NO_CACHE_SUBSCRIPTION = (): (() => void) => () => {};

/**
 * Does the tuple's query hold a value — has its `dataUpdatedAt` left epoch 0
 * (a query with no data yet, and an absent query, sit at 0)? The `gate` latch, derived
 * from the query cache through `useSyncExternalStore` (an external store read
 * in render, so the React Compiler cannot memoize it stale): it flips with the
 * cache write that lands the value — re-rendering the read once, which is the
 * flip the gate exists to guarantee — and starts true for a tuple the cache
 * already holds (boot-hydrated, or another observer's), so such a read renders
 * select-scoped from its first render.
 *
 * The cache listener exists ONLY while the latch is open: `QueryCache.notify`
 * runs every listener on every cache event of any query (and each observer of
 * a pushed tuple emits one), so a listener per settled gated read would make
 * a push cost O(observers × gated reads). A read whose tuple already holds a
 * value adds none, and an open read's listener removes itself with the event
 * that lands the value. After that the read relies on its own observer: a
 * reset that changes `data` re-renders the narrowed observer (and re-reads the
 * snapshot), and the widened observer it then becomes re-renders on the next
 * `dataUpdatedAt` change.
 */
function useTupleHasValue(
  queryClient: QueryClient,
  queryKey: unknown[],
  enabled: boolean,
): boolean {
  const cache = queryClient.getQueryCache();
  const queryHash = hashKey(queryKey);
  const subscribe = useCallback(
    (onChange: () => void) => {
      const holdsValue = (): boolean =>
        (cache.get(queryHash)?.state.dataUpdatedAt ?? 0) !== 0;
      if (!enabled || holdsValue()) return NO_CACHE_SUBSCRIPTION();
      const unsubscribe = cache.subscribe((event) => {
        if (event.query.queryHash !== queryHash) return;
        if (holdsValue()) unsubscribe();
        onChange();
      });
      return unsubscribe;
    },
    [cache, queryHash, enabled],
  );
  const snapshot = (): boolean =>
    enabled && (cache.get(queryHash)?.state.dataUpdatedAt ?? 0) !== 0;
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** A skipped read (`params === null`) has nothing to refetch. */
const SKIPPED_REFETCH = (): Promise<void> => Promise.resolve();
/** The second query-key element of a skipped read — never a params object. */
const SKIPPED_KEY = "\0skipped";

// AGENT RULE: Never cast the `data` returned by useResource (e.g. `data as Foo[]`).
// `data` is only accessible after narrowing to `result.status === "ready"`.
// The generic T is inferred from the ResourceDescriptor — casting silently hides type
// mismatches between the resource payload and your assumption.
//
// `params === null` is the substrate's SKIP — "there is no subject to read yet"
// (public spelling: `useLive(value, null)`, `useLiveRow(c, null)`). Every hook
// still runs (the call site's hook order is stable while its params flip), but
// nothing is read: no subscription, no HTTP read or cold-start prime, and no
// pending-mount count (the page is not waiting on the server for it). The query
// sits on a per-key skip key whose `queryFn` is React Query's `skipToken`, so no
// refetch path can run it. The result is the loading arm, for as
// long as the params stay `null`.
export function useResource<T, P extends ResourceParams = ResourceParams>(
  resource: ResourceDescriptor<T, P>,
  params?: P | null,
): ResourceResult<T>;
export function useResource<T, S, P extends ResourceParams = ResourceParams>(
  resource: ResourceDescriptor<T, P>,
  params: P | undefined | null,
  options: UseResourceOptions<T, S>,
): ResourceResult<S>;
export function useResource<
  T,
  S = T,
  P extends ResourceParams = ResourceParams,
>(
  resource: ResourceDescriptor<T, P>,
  params: P | undefined | null,
  options: UseResourceGateOptions<T, S>,
): ResourceResult<T | S>;
export function useResource<T, S, P extends ResourceParams = ResourceParams>(
  resource: ResourceDescriptor<T, P>,
  params?: P | null,
  options?: UseResourceOptions<T, S> | UseResourceGateOptions<T, S>,
): ResourceResult<T | S> {
  const notifications = useContext(NotificationsContext);
  if (!notifications) {
    throw new Error("useResource must be used within a NotificationsProvider");
  }
  const key = resource.key;
  const origin = resource.origin;
  const skipped = params === null;
  // Canonical: one logical read is one tuple on every path it takes (the sub,
  // the HTTP fallback URL, the prime, the query key) — see `canonicalParams`.
  const p = useCanonicalParams(params, resource.optionalParams);

  // Measure mount→settle so a domain plugin can report slow resources. Reported
  // once, the first time `pending` flips true→false (see effect below).
  const startRef = useRef<number | null>(null);
  const reportedRef = useRef(false);

  const { schema, refusals, bytes } = resource;
  const select = options?.select;
  const gate = options?.gate === true;

  // Refcount sub/unsub on mount/unmount. `p` keeps its identity per canonical
  // tuple (`useCanonicalParams`), so it is a stable dep however callers spell
  // their params object.
  const keyOf = resource.keyed?.keyOf;
  useEffect(() => {
    if (skipped) return;
    startRef.current = performance.now();
    notifications.observe(key, p, origin, { schema, refusals, bytes }, keyOf);
    return () => notifications.unobserve(key, p, origin);
  }, [notifications, key, origin, schema, refusals, bytes, keyOf, skipped, p]);

  // A skipped read's key is per resource key (never shared across descriptors,
  // whose options differ) and can never collide with a params tuple.
  const queryKey = skipped ? [key, SKIPPED_KEY] : queryKeyFor(key, p);
  const keyStr = JSON.stringify(queryKey);
  // `gate`: keep the notifications un-scoped until THIS tuple holds a value,
  // so the pending→settled flip is guaranteed to re-render (a select-scoped
  // observer flips silently when the slice is identical across the
  // boundary). The latch is DERIVED from the query cache
  // (`useTupleHasValue`), never held as state: a read whose tuple is already
  // cached — boot-hydrated, or another observer's — narrows on its FIRST
  // render, a params change re-gates exactly when the new tuple has no value
  // yet, and no settle effect costs a render. Only the notifications are
  // gated: the selector is applied on every render, so the slice is always
  // the query's own (a selector switched off and on again would let React
  // Query hand back the slice it memoized for the PREVIOUS tuple). A gated
  // read with NO selector narrows the same way and hands back the cached
  // value itself (`UseResourceGateOptions`).
  const queryClient = useQueryClient();
  const gating = !skipped && gate;
  const tupleHasValue = useTupleHasValue(queryClient, queryKey, gating);
  const narrowed = gate ? tupleHasValue : select !== undefined;

  // A skipped read sits on a per-key skip key with `skipToken`, so no refetch
  // path (a manual one, `refetchQueries`, the on-demand `enabled` default) can
  // run it; every other read is the shared tuple query.
  const tuple = skipped ? null : tupleQueryOptions(notifications, resource, p);
  const q = useQuery({
    queryKey,
    queryFn: tuple?.queryFn ?? skipToken,
    ...(tuple?.enabled ? { enabled: tuple.enabled } : {}),
    structuralSharing: dateAwareReplaceEqualDeep,
    ...(tuple?.gcTime !== undefined ? { gcTime: tuple.gcTime } : {}),
    // With a selector (or a settled gate), narrow re-renders to the selected
    // slice (the value): structural sharing keeps a deeply-equal one's
    // reference, and limiting
    // notifyOnChangeProps to data/error stops the per-push `dataUpdatedAt`
    // bump (which fires on every push) from forcing a re-render. We still read
    // `q.dataUpdatedAt` below for `pending` — reading a prop does not re-enable
    // it once notifyOnChangeProps is an explicit list.
    ...(select !== undefined ? { select } : {}),
    ...(narrowed ? { notifyOnChangeProps: ["data", "error"] as const } : {}),
  });

  // `hasValue` — a real value has landed at least once (`dataUpdatedAt` leaves
  // epoch 0 only on a successful load). The internal branches below key off
  // it, not on "loaded and not errored", so an error does not re-prime or
  // re-time the mount→settle metric. A skipped read has none.
  const hasValue = !skipped && q.dataUpdatedAt !== 0;
  // The one typed failure (memoized per raw error, so every observer of the
  // query shares one `ResourceError` identity).
  const error = skipped || q.error === null ? null : toResourceError(q.error);

  // Cold-start accelerator: if this resource mounts before the live-state
  // transport has EVER been ready (a cold deep-link — the notifications socket is
  // starved for seconds by main-thread saturation), fetch the first value over
  // plain HTTP in parallel with the socket coming up, so content settles ~2.5s
  // sooner instead of waiting on the batched WS sub-ack. Fires at most once per
  // (key,params), only while still pending (no hydrated/boot-snapshot value), and
  // only on genuine cold start. Warm navigations (transport already opened once)
  // skip this entirely, so the warm path is unchanged. The later WS sub-ack
  // reconciles via the shared version guard.
  const primedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (hasValue || skipped) return;
    if (notifications.hasEverBeenReady(origin)) return;
    if (primedKeyRef.current === keyStr) return;
    primedKeyRef.current = keyStr;
    void notifications.primeFromHttp(key, p, origin);
  }, [hasValue, skipped, keyStr, notifications, key, origin, p]);

  // Count this read as "still waiting for data" from mount until its first value
  // lands (the cleanup runs on the `hasValue` flip, on unmount, and on a key
  // change). The page-wide count is how a page load or a navigation knows it is
  // on screen — see pending-mount-tracker.ts. Keyed on `hasValue`, not
  // `pending`: a transient error does not make the page "loading again".
  // A skipped read waits on nothing, so it is never counted.
  useEffect(() => {
    if (hasValue || skipped) return;
    return notePendingMount(key);
  }, [hasValue, skipped, key, keyStr]);

  // Report the mount→settle duration once, the first time this resource leaves
  // `pending` (`reportTupleSettled`).
  useEffect(() => {
    if (hasValue && !reportedRef.current) {
      reportedRef.current = true;
      reportTupleSettled(notifications, key, p, startRef.current);
    }
  }, [hasValue, notifications, key, p]);

  // The query applies the selector itself (above), so `q.data` is already the
  // slice when one is passed.
  const data = q.data as T | S;
  const refetchQuery = useEventCallback(() => q.refetch());

  // The result identity recomputes only on data/error (which decide the
  // status); the returned `refetch` calls the freshest `q.refetch` through the
  // stable `refetchQuery`. `hasValue` is the landed signal, not
  // `data !== undefined`: a selector may answer `undefined` for a landed value
  // (a point lookup that finds nothing), which is `ready`, not `loading`. The
  // error arm's `stale` is the SELECTED slice once a value has landed — a
  // first-load failure has no trustworthy value to expose. A skipped read
  // (`params === null`, no subject yet) is `loading` with nothing to refetch.
  return useMemo((): ResourceResult<T | S> => {
    if (skipped) return { status: "loading", refetch: SKIPPED_REFETCH };
    return queryResult(data, error, refetchQuery, hasValue);
  }, [skipped, hasValue, data, error, refetchQuery]);
}

/** One tuple's read state, as `useResources`' combine reads it off its query. */
interface TupleState {
  hasValue: boolean;
  data: unknown;
  error: Error | null;
}

/**
 * `useQueries`' `combine`: each query's read state as plain data, KEYED BY ITS
 * TUPLE (`tupleKeys[i]` names `results[i]`). React Query structurally shares
 * the combined result with the previous one, so an unchanged tuple's state —
 * and its `data` — stays the same object, and a combine that changed nothing
 * notifies no one. Keyed, not positional: sharing an ARRAY pairs entries by
 * index, so after a reorder, or a tuple added or removed before another, it
 * merges one tuple's previous data into another's and hands out a deep COPY —
 * a kept tuple's data would lose its identity on every list change.
 */
function combineTuples(
  results: readonly QueryObserverResult<unknown>[],
  tupleKeys: readonly string[],
): Record<string, TupleState> {
  const byTuple: Record<string, TupleState> = {};
  results.forEach((q, i) => {
    byTuple[tupleKeys[i]!] = {
      hasValue: q.dataUpdatedAt !== 0,
      data: q.data,
      error: q.error,
    };
  });
  return byTuple;
}

/**
 * One tuple of a `useResources` read: its `ResourceResult`, and where its
 * value was last applied on the client-wide apply sequence — of two tuples,
 * the higher `appliedSeq` holds the more recently applied value (`0`: nothing
 * applied through this tab's sub yet, a boot-hydrated value included).
 */
export type ResourceTupleResult<T> = ResourceResult<T> & {
  appliedSeq: number;
};

/** How `useResources` lets go of a tuple dropped from its list. */
export interface UseResourcesOptions<
  P extends ResourceParams = ResourceParams,
> {
  /**
   * `"now"`: a tuple removed from the list while the hook stays mounted is
   * unsubscribed at once instead of after the keep-alive window — for a
   * reader that drops a tuple on purpose and will not remount it (a paged
   * read's page leaving its band). Unmounting the hook still releases through
   * the keep-alive (a remount reuses the live subs). Default: the keep-alive.
   */
  release?: "now";
  /**
   * Per tuple of `paramsList` (same length, same order): how to seed it from
   * rows this tab already holds when it is first subscribed — `null` for a
   * plain load. Read only when a tuple ENTERS the list (a fresh sub), never
   * for one kept across a change; see `ResourceDerivation` for what the
   * caller vouches for and what the server checks.
   */
  derive?: readonly (ResourceDerivation<P> | null)[];
}

/**
 * Read a VARYING number of tuples of one resource — `useResource` for a list of
 * params whose length changes over time (a paged read's pages), which a hook
 * call per tuple cannot express. Each tuple is read exactly as `useResource`
 * reads it — the same query (key, HTTP fallback, enabled rule, GC rule), the
 * same `observe` / `unobserve` refcount (a tuple another component also reads
 * is subscribed once), the same cold-start prime, and the same pending-mount
 * count until its first value — and yields the same `ResourceResult` states
 * (each with its `appliedSeq`), in `paramsList` order, and each tuple's
 * mount→settle is reported once (`reportTupleSettled`). No `select` and no
 * `gate`.
 *
 * The subscription set moves by DIFF: a tuple kept across a list change (moved,
 * or with others added or removed around it) stays observed throughout — it is
 * never unobserved and re-observed, which would let its socket subscription
 * lapse — and a removed tuple is unobserved only after the new ones are
 * observed.
 */
export function useResources<T, P extends ResourceParams = ResourceParams>(
  resource: ResourceDescriptor<T, P>,
  paramsList: readonly P[],
  options: UseResourcesOptions<P> = {},
): readonly ResourceTupleResult<T>[] {
  const release = options.release === "now" ? "now" : "keep-alive";
  const derive = options.derive;
  if (derive !== undefined && derive.length !== paramsList.length) {
    throw new Error(
      `useResources(${resource.key}): derive has ${derive.length} entries for ${paramsList.length} tuples — one per tuple, null for a plain load`,
    );
  }
  const notifications = useContext(NotificationsContext);
  if (!notifications) {
    throw new Error("useResources must be used within a NotificationsProvider");
  }
  const queryClient = useQueryClient();
  const { key, origin, schema, refusals, bytes } = resource;
  const keyOf = resource.keyed?.keyOf;
  // Canonical tuples (see `canonicalParams`), one identity per canonical list.
  const listJson = JSON.stringify(
    paramsList.map((p) => canonicalParams(p, resource.optionalParams)),
  );
  const list = useMemo(
    () => JSON.parse(listJson) as ResourceParams[],
    [listJson],
  );
  const tupleKeys = useMemo(
    () => list.map((p) => JSON.stringify(queryKeyFor(key, p))),
    [list, key],
  );

  // Refcount by diff (see above). The unmount cleanup releases whatever is
  // observed at that point; StrictMode's mount → cleanup → mount observes again
  // from an empty set.
  const observedRef = useRef<Map<string, ResourceParams>>(new Map());
  // When each tuple was first observed, for its mount→settle report.
  const startedRef = useRef<Map<string, number>>(new Map());
  // Each tuple's derivation, canonical like its params — read only for a
  // tuple the effect below sees enter the list.
  const derivations = useMemo(
    () =>
      derive?.map((d) =>
        d === null
          ? undefined
          : {
              from: d.from.map((s) => ({
                ...s,
                params: canonicalParams(s.params, resource.optionalParams),
              })),
            },
      ),
    [derive, resource.optionalParams],
  );
  useEffect(() => {
    const next = new Map(list.map((p, i) => [tupleKeys[i]!, p]));
    const prev = observedRef.current;
    const entered = new Set<string>();
    list.forEach((p, i) => {
      const k = tupleKeys[i]!;
      if (prev.has(k) || entered.has(k)) return;
      entered.add(k);
      if (!startedRef.current.has(k))
        startedRef.current.set(k, performance.now());
      notifications.observe(
        key,
        p,
        origin,
        { schema, refusals, bytes },
        keyOf,
        derivations?.[i],
      );
    });
    for (const [k, p] of prev) {
      if (!next.has(k)) notifications.unobserve(key, p, origin, release);
    }
    observedRef.current = next;
  }, [
    notifications,
    key,
    origin,
    schema,
    keyOf,
    list,
    tupleKeys,
    release,
    derivations,
    refusals,
    bytes,
  ]);
  useEffect(
    () => () => {
      for (const p of observedRef.current.values()) {
        notifications.unobserve(key, p, origin);
      }
      observedRef.current = new Map();
    },
    [notifications, key, origin],
  );

  // Stable per tuple list, so React Query re-runs it only when a query's
  // result (or the list) changed.
  const combine = useCallback(
    (results: readonly QueryObserverResult<unknown>[]) =>
      combineTuples(results, tupleKeys),
    [tupleKeys],
  );
  const byTuple = useQueries({
    queries: list.map((p) => tupleQueryOptions(notifications, resource, p)),
    combine,
  });
  const states = useMemo(
    () => tupleKeys.map((k) => byTuple[k]!),
    [byTuple, tupleKeys],
  );

  // Tuples with no value yet: counted as pending mounts, and — before the
  // transport was ever ready — primed over HTTP once each, as `useResource`
  // does for its one tuple.
  const waitingJson = JSON.stringify(
    tupleKeys.filter((_, i) => states[i]?.hasValue !== true),
  );
  const primedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (notifications.hasEverBeenReady(origin)) return;
    const waiting = new Set(JSON.parse(waitingJson) as string[]);
    list.forEach((p, i) => {
      const k = tupleKeys[i]!;
      if (!waiting.has(k) || primedRef.current.has(k)) return;
      primedRef.current.add(k);
      void notifications.primeFromHttp(key, p, origin);
    });
  }, [notifications, origin, key, list, tupleKeys, waitingJson]);
  const releasesRef = useRef<Map<string, () => void>>(new Map());
  useEffect(() => {
    const waiting = new Set(JSON.parse(waitingJson) as string[]);
    const releases = releasesRef.current;
    for (const k of waiting) {
      if (!releases.has(k)) releases.set(k, notePendingMount(key));
    }
    for (const [k, release] of releases) {
      if (!waiting.has(k)) {
        release();
        releases.delete(k);
      }
    }
  }, [waitingJson, key]);
  useEffect(
    () => () => {
      for (const release of releasesRef.current.values()) release();
      releasesRef.current = new Map();
    },
    [key],
  );
  // Each tuple's first value: its mount→settle report, once per tuple.
  const reportedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    list.forEach((p, i) => {
      const k = tupleKeys[i]!;
      if (states[i]?.hasValue !== true || reportedRef.current.has(k)) return;
      reportedRef.current.add(k);
      reportTupleSettled(
        notifications,
        key,
        p,
        startedRef.current.get(k) ?? null,
      );
    });
  }, [notifications, key, list, tupleKeys, states]);

  // One result object per tuple STATE and apply position: the combine shares
  // each tuple's state keyed by tuple (an unchanged tuple keeps its
  // TupleState object), so a tuple whose read did not move returns the very
  // result — and `refetch` — it returned before, and a memoized per-tuple
  // child does not re-render because ANOTHER tuple of the list changed. The
  // entry also records the `appliedSeq` it was built at: an apply that left
  // the value deep-equal (so the same TupleState) still moves the tuple's
  // `appliedSeq`, which a paged read's dedup ranks rows by, so the result is
  // rebuilt then. A state object belongs to one tuple of one resource on one
  // client (another key, list entry or client is another combine path, so
  // another object), so the cache needs no reset.
  const [byState] = useState(
    () =>
      new WeakMap<
        TupleState,
        { appliedSeq: number; result: ResourceTupleResult<T> }
      >(),
  );
  return useMemo(() => {
    return states.map((st, i): ResourceTupleResult<T> => {
      // Read beside the value it describes: the apply that wrote this
      // tuple's value bumped it before the render this value reaches.
      const appliedSeq = notifications.appliedSeq(key, list[i]!, origin);
      const cached = byState.get(st);
      if (cached !== undefined && cached.appliedSeq === appliedSeq)
        return cached.result;
      const queryKey = queryKeyFor(key, list[i]!);
      // A manual refetch ignores `enabled` and starts a NEW read even while
      // one is in flight (`cancelRefetch`), as `useResource`'s `q.refetch()`
      // does — a snapshot's `refresh()` must re-measure now, not hand back a
      // measurement started before the click.
      const refetch = () =>
        (
          queryClient
            .getQueryCache()
            .find({ queryKey, exact: true })
            ?.fetch(undefined, { cancelRefetch: true }) ?? Promise.resolve()
        ).then(() => {});
      // The same three states, in the same precedence, as `useResource`.
      let result: ResourceTupleResult<T>;
      if (st.error !== null) {
        const error = toResourceError(st.error);
        result = st.hasValue
          ? {
              status: "error",
              error,
              stale: st.data as T,
              refetch,
              appliedSeq,
            }
          : { status: "error", error, refetch, appliedSeq };
      } else if (!st.hasValue) {
        result = { status: "loading", refetch, appliedSeq };
      } else {
        result = { status: "ready", data: st.data as T, refetch, appliedSeq };
      }
      byState.set(st, { appliedSeq, result });
      return result;
    });
  }, [states, list, key, queryClient, notifications, origin, byState]);
}
