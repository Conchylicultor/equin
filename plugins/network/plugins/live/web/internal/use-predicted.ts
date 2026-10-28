import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  transportScoped,
  useTransportScoped,
} from "@plugins/primitives/plugins/networking/web";
import {
  createPredictStore,
  type PredictOp,
  type PredictRow,
  type PredictStore,
} from "./predict-overlay";

// The read side's hooks into the predict overlay (`predict-overlay.ts`): the
// subtree's store, the ops touching an entity, and the registration of a
// mounted read as a HOLDER of its tuple's server rows.

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
 * The ops in flight that touch `entity` (`null`: a read of no entity — none).
 * A stable array while they do not change, so a read no prediction touches
 * re-renders on nothing here.
 */
export function usePredictedOps(
  store: PredictStore,
  entity: string | null,
): readonly PredictOp[] {
  return useSyncExternalStore(
    entity === null ? noSubscribe : store.subscribe,
    entity === null ? () => NO_OPS : () => store.opsFor(entity),
  );
}

/**
 * Register this read as a holder of `tupleKey`'s server rows for as long as it
 * is mounted (`entity` `null`: nothing to hold), and re-decide the ops on its
 * data-change edge — the push that may confirm one. `rows` is the tuple's
 * SERVER rows (never the overlaid ones), `undefined` while it holds none.
 */
export function usePredictHolder(
  store: PredictStore,
  entity: string | null,
  tupleKey: string | null,
  idField: string,
  rows: readonly PredictRow[] | undefined,
): void {
  const rowsRef = useRef(rows);
  useLayoutEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  useLayoutEffect(() => {
    if (entity === null || tupleKey === null) return;
    return store.register({
      tupleKey,
      entity,
      idField,
      rows: () => rowsRef.current,
    });
  }, [store, entity, tupleKey, idField]);
  useEffect(() => {
    if (entity === null || tupleKey === null) return;
    store.sweep();
  }, [store, entity, tupleKey, rows]);
}
