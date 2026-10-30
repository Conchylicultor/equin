import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  transportScoped,
  useTransportScoped,
} from "@plugins/primitives/plugins/networking/web";
import {
  useLiveRegistries,
  useNotificationsClient,
  type LiveRegistries,
} from "@plugins/primitives/plugins/live-state/web";
import { compareTxWatermark } from "@plugins/primitives/plugins/live-state/core";
import { isTransactionId } from "@plugins/infra/plugins/endpoints/core";
import {
  confirmedByCommit,
  createPredictStore,
  type CommitSeen,
  type PredictOp,
  type PredictRow,
  type PredictStore,
  type PredictTuple,
} from "./predict-overlay";

// The read side's hooks into the predict overlay (`predict-overlay.ts`): the
// subtree's store, the ops touching a subject, and the registration of a
// mounted read as a HOLDER of its tuple's server data — with what tells the
// overlay its frames have seen a write's commit (its tuples' ack and
// watermark registries), and the ack interest that makes those frames come.

/**
 * One overlay per transport — a demo scope's predictions stay its own. Read by
 * the live reads (`usePredictStore`) and the transport's predicted-write
 * writer (`use-live-mutation.ts`).
 */
export const predictStores = transportScoped<PredictStore>(() =>
  createPredictStore(),
);

/** The predict overlay of the enclosing subtree's transport. */
export function usePredictStore(): PredictStore {
  return useTransportScoped(predictStores);
}

const NO_OPS: readonly PredictOp[] = Object.freeze([]);
const noSubscribe = (): (() => void) => () => {};

/**
 * The ops in flight that touch `subject` (`null`: a read of no subject —
 * none). A stable array while they do not change, so a read no prediction
 * touches re-renders on nothing here.
 */
export function usePredictedOps(
  store: PredictStore,
  subject: string | null,
): readonly PredictOp[] {
  return useSyncExternalStore(
    subject === null ? noSubscribe : store.subscribe,
    subject === null ? () => NO_OPS : () => store.opsFor(subject),
  );
}

/**
 * The live tuples a holder's server data comes from: the resource and the
 * canonical params of each (one for a by-id or `all` read, one per live page
 * for a window).
 */
export interface HeldTuples {
  readonly resource: {
    readonly key: string;
    readonly origin?: "worktree" | "central";
  };
  readonly params: readonly Readonly<Record<string, string>>[];
}

/**
 * Whether every tuple of `held` has seen a commit ack: one of its writes
 * acked on the tuple (Rule A — the tuple's rows re-read after it), or a full
 * frame's watermark strictly past all of them (Rule B′ — the snapshot saw them
 * committed). A watermark vouches for TRANSACTIONS only: every frame carries
 * one, an external value's too, but no Postgres snapshot can say a config file
 * was rewritten — so a write naming an external id (`isTransactionId` false)
 * is seen through Rule A alone. A read of no tuple has seen nothing.
 */
function commitSeen(registries: LiveRegistries, held: HeldTuples): CommitSeen {
  const { key } = held.resource;
  return (commits) => {
    const onlyTransactions = commits.every(isTransactionId);
    return (
      held.params.length > 0 &&
      held.params.every((params) => {
        if (commits.some((t) => registries.txAcks.has(key, params, t))) {
          return true;
        }
        const wm = registries.watermarks.get(key, params);
        return (
          wm !== undefined &&
          onlyTransactions &&
          commits.every((t) => compareTxWatermark(wm, t) > 0)
        );
      })
    );
  };
}

/**
 * While an op confirmed by commit applies to `tupleKey`, ask the server for
 * this read's tuples' ack frames (a recompute that changed nothing visible
 * still names the transactions it folded in) and re-decide on each one: the
 * edge that confirms a write whose frame shows no change. A read no such op
 * touches asks for nothing.
 */
function useCommitAcks(
  store: PredictStore,
  ops: readonly PredictOp[],
  subject: string | null,
  tupleKey: string | null,
  held: HeldTuples | null,
): void {
  const client = useNotificationsClient();
  const registries = useLiveRegistries();
  const wants =
    subject !== null &&
    tupleKey !== null &&
    held !== null &&
    ops.some(
      (op) =>
        !op.retired.has(tupleKey) &&
        op.targets.some((t) => t.subject === subject && confirmedByCommit(t)),
    );
  const key = held?.resource.key ?? null;
  const origin = held?.resource.origin;
  const paramsJson = held === null ? "[]" : JSON.stringify(held.params);
  useEffect(() => {
    if (!wants || key === null) return;
    const params = JSON.parse(paramsJson) as Record<string, string>[];
    const releases = params.map((p) =>
      client.requestAcks(key, p, origin === "central" ? "central" : undefined),
    );
    const unsubscribe = registries.txAcks.subscribe((ackedKey) => {
      if (ackedKey === key) store.sweep();
    });
    return () => {
      unsubscribe();
      for (const release of releases) release();
    };
  }, [wants, key, origin, paramsJson, client, registries, store]);
}

/**
 * Register this read as a holder of its tuple's server rows for as long as it
 * is mounted (`tuple` `null`: nothing to hold), and re-decide the ops on its
 * data-change edge — the push that may confirm one. `rows` is the tuple's
 * SERVER rows (never the overlaid ones), `undefined` while it holds none;
 * `held` the live tuples they come from (what a commit is seen on).
 */
export function usePredictHolder(
  store: PredictStore,
  ops: readonly PredictOp[],
  tuple: PredictTuple | null,
  rows: readonly PredictRow[] | undefined,
  held: HeldTuples | null,
): void {
  const registries = useLiveRegistries();
  const rowsRef = useRef(rows);
  const tupleRef = useRef(tuple);
  const heldRef = useRef(held);
  useLayoutEffect(() => {
    rowsRef.current = rows;
    tupleRef.current = tuple;
    heldRef.current = held;
  }, [rows, tuple, held]);
  const subject = tuple?.subject ?? null;
  const tupleKey = tuple?.tupleKey ?? null;
  const idField = tuple?.idField ?? "id";
  useLayoutEffect(() => {
    if (subject === null || tupleKey === null) return;
    return store.register({
      kind: "rows",
      tupleKey,
      subject,
      idField,
      // The tuple's other facts (membership, admission, order) are read
      // live: they change with the read, its registration does not.
      get membership() {
        return tupleRef.current?.membership;
      },
      get entrant() {
        return tupleRef.current?.entrant;
      },
      get order() {
        return tupleRef.current?.order;
      },
      get more() {
        return tupleRef.current?.more;
      },
      rows: () => rowsRef.current,
      seen: (commits) =>
        heldRef.current !== null &&
        commitSeen(registries, heldRef.current)(commits),
    });
  }, [store, subject, tupleKey, idField, registries]);
  useEffect(() => {
    if (subject === null || tupleKey === null) return;
    store.sweep();
  }, [store, subject, tupleKey, rows]);
  useCommitAcks(store, ops, subject, tupleKey, held);
}

/**
 * Register a read of one value tuple as a holder (`subject` `null`: nothing
 * to hold) — the value twin of {@link usePredictHolder}.
 */
export function usePredictValueHolder(
  store: PredictStore,
  ops: readonly PredictOp[],
  subject: string | null,
  key: string,
  paramsKey: string,
  value: { readonly held: boolean; readonly data: unknown },
  held: HeldTuples | null,
): void {
  const registries = useLiveRegistries();
  const heldValue = useRef(value.held);
  const heldRef = useRef(held);
  useLayoutEffect(() => {
    heldValue.current = value.held;
    heldRef.current = held;
  }, [value.held, held]);
  const tupleKey = `${key}|${paramsKey}`;
  useLayoutEffect(() => {
    if (subject === null) return;
    return store.register({
      kind: "value",
      tupleKey,
      subject,
      key,
      paramsKey,
      held: () => heldValue.current,
      seen: (commits) =>
        heldRef.current !== null &&
        commitSeen(registries, heldRef.current)(commits),
    });
  }, [store, subject, tupleKey, key, paramsKey, registries]);
  useEffect(() => {
    if (subject === null) return;
    store.sweep();
  }, [store, subject, value.data]);
  useCommitAcks(store, ops, subject, subject === null ? null : tupleKey, held);
}

/** A stable {@link HeldTuples} for one tuple (`null` params: none). */
export function useHeldTuple(
  resource: HeldTuples["resource"],
  params: Readonly<Record<string, string>> | null,
): HeldTuples | null {
  const json = params === null ? null : JSON.stringify(params);
  const { key, origin } = resource;
  return useMemo(
    () =>
      json === null
        ? null
        : {
            resource: { key, ...(origin === undefined ? {} : { origin }) },
            params: [JSON.parse(json) as Record<string, string>],
          },
    [key, origin, json],
  );
}
