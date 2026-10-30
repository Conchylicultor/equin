import { useMemo } from "react";
import { canonicalParams } from "@plugins/packages/plugins/canonical-params/core";
import {
  useNotificationsClient,
  type ResourceDescriptor,
} from "@plugins/primitives/plugins/live-state/web";
import type {
  LivePlainValue,
  LiveQueryValue,
  LiveValueOrigin,
} from "@plugins/network/plugins/live/core";
import { useTransport } from "@plugins/primitives/plugins/networking/web";
import {
  unavailableMessage,
  type MachineFeature,
} from "@plugins/infra/plugins/endpoints/core";
import type { LiveUnavailable, MachineDecl, RefusalsDecl } from "./use-live";

// The event-shaped read of a live value: ONE answer to a question an event
// asks and its own `await` consumes (validate then act, read then confirm).
// It reads the same declarations as `useLive` — the same tuple, refusals,
// machine arm and transport — and adds no declaration surface. Wherever
// `useLive` fits (a render, a hook, an effect), it is the read; this one is
// for the click whose continuation needs the answer. Design:
// research/2026-10-26-global-browser-reads-only-through-live.md §2.

/**
 * One answer of a {@link LiveReader}: the value, a refusal the declaration
 * lists (`code` typed by it — only a value that declares refusals can be
 * refused), or — only for a declaration that needs the computer, under a
 * transport with none behind it — `unavailable`, read without a request. A
 * failure is never an answer: the read rejects with its `ResourceError`.
 */
export type LiveAnswer<
  T,
  C extends string = never,
  NM extends MachineFeature | undefined = undefined,
> =
  | { status: "ready"; data: T }
  | ([C] extends [never]
      ? never
      : { status: "refused"; code: C; message: string })
  | ([NM] extends [MachineFeature] ? LiveUnavailable : never);

/**
 * A plain value's params argument for one read: absent for a param-less
 * value, required otherwise — exactly one tuple. No `null` (an event asks a
 * question it has: there is no "not yet" in an `await`) and no list (one
 * question, one answer).
 */
type LiveReaderArgs<P> = string extends keyof P
  ? []
  : [keyof P] extends [never]
    ? []
    : [params: P];

/**
 * Read one tuple of a `liveValue` now (`useLiveReader()`'s function). Takes a
 * plain value (`read(v)` / `read(v, params)`) or a typed-query value
 * (`read(v, query)`); a paged value, a collection, a `null` or a list of
 * tuples is a tsc error (and throws for an untyped caller).
 */
export interface LiveReader {
  <
    T,
    Q,
    QIn,
    C extends string = never,
    NM extends MachineFeature | undefined = undefined,
  >(
    value: LiveQueryValue<T, Q, QIn, LiveValueOrigin> &
      RefusalsDecl<C> &
      MachineDecl<NM>,
    query: NoInfer<QIn>,
  ): Promise<LiveAnswer<T, NoInfer<C>, NM>>;
  <
    T,
    P extends Record<string, string>,
    C extends string = never,
    NM extends MachineFeature | undefined = undefined,
  >(
    value: LivePlainValue<T, P, LiveValueOrigin> &
      RefusalsDecl<C> &
      MachineDecl<NM>,
    // `NoInfer`: `P` is the declaration's, as for `useLive`.
    ...params: LiveReaderArgs<NoInfer<P>>
  ): Promise<LiveAnswer<T, NoInfer<C>, NM>>;
}

/**
 * The read function of this subtree's live pipeline: `read(value, params?)`
 * resolves ONE answer (see {@link LiveAnswer}) — for a question an event asks
 * and its own `await` consumes. Never call it from a render, a hook body or
 * an effect: there, the read is `useLive`.
 *
 * - **One tuple, `useLive`'s**: params through `canonicalParams`, a typed
 *   query through the declaration's own codec — the same cache key.
 * - **Observed tuple** (a `useLive` of it is mounted and current): its pushed
 *   value, no request. **Otherwise** one HTTP read of
 *   `/api/(central-)resources/:key` through the transport, concurrent reads
 *   of a tuple sharing it — and an unobserved tuple's answer is never written
 *   to the cache. A `load: "snapshot"` value is always read (measured now).
 * - **`needsMachine`** under a transport without the computer: `unavailable`,
 *   no request.
 * - **Failures reject** with the `ResourceError` (network, `loader-failed`,
 *   `contract-mismatch` — an undeclared refusal code included), reported once
 *   to the live read error sink.
 */
export function useLiveReader(): LiveReader {
  const client = useNotificationsClient();
  const { machine } = useTransport();
  return useMemo(() => {
    const read = (value: AnyValue, ...rest: unknown[]) => {
      const decl = readableValue(value, rest);
      if (decl.needsMachine !== undefined && !machine) {
        return Promise.resolve({
          status: "unavailable",
          message: unavailableMessage(decl.needsMachine),
        });
      }
      const arg = rest[0];
      const params =
        decl.query !== undefined
          ? decl.query.encode(arg)
          : canonicalParams(
              (arg ?? {}) as Record<string, string>,
              decl.optionalParams,
            );
      return client.readOnce(
        decl.key,
        params,
        decl.origin,
        decl,
        decl.snapshot === true,
      );
    };
    return read as LiveReader;
  }, [client, machine]);
}

/** A value declaration as the reader reads it, untyped. */
type AnyValue = ResourceDescriptor<unknown, Record<string, string>> & {
  live?: string;
  paged?: unknown;
  snapshot?: true;
  needsMachine?: MachineFeature;
  query?: { encode: (query: unknown) => Record<string, string> };
};

/** `value`, checked to be one tuple of a plain or typed-query value — or a throw naming what it is instead. */
function readableValue(value: AnyValue, rest: readonly unknown[]): AnyValue {
  const name = `useLiveReader("${value.key}")`;
  if (value.live !== "value") {
    throw new Error(
      `${name}: a collection is read with useLive — the reader answers one tuple of a liveValue.`,
    );
  }
  if (value.paged !== undefined) {
    throw new Error(
      `${name}: a paged value is read with useLive — its pages are kept live, not answered once.`,
    );
  }
  if (rest[0] === null) {
    throw new Error(
      `${name}: null params — an event asks a question it has; a subject not known yet is useLive's \`null\`.`,
    );
  }
  if (Array.isArray(rest[0])) {
    throw new Error(
      `${name}: a list of tuples — the reader answers one question per call.`,
    );
  }
  return value;
}
