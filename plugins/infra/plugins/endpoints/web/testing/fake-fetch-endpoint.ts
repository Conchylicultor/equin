import type { ReactElement, ReactNode } from "react";
import {
  testTransport,
  transportWrapper,
} from "@plugins/primitives/plugins/networking/web/testing";
import type { Transport } from "@plugins/primitives/plugins/networking/web";
import type { EndpointDef, MachineEndpointDef } from "../../core";
import { unavailableMessage } from "../../core";
import {
  installFakeFetcher,
  type FetchEndpoint,
  type FetchOpts,
} from "../internal/fetch-endpoint";

type AnyEndpoint =
  | EndpointDef<string, unknown, unknown, unknown, unknown>
  | MachineEndpointDef<string, unknown, unknown, unknown, unknown>;

/** One call a fake fetcher received. */
export interface FetchEndpointCall {
  endpoint: AnyEndpoint;
  /** `endpoint.route` — "METHOD /path/:param", what a test usually matches on. */
  route: string;
  params: unknown;
  body: unknown;
  query: unknown;
  opts: FetchOpts<unknown, unknown> | undefined;
}

/**
 * What the fake answers a call with: the decoded response (or a promise of
 * it); throwing (or rejecting) fails the call. For a `needsMachine` endpoint it
 * is the VALUE — the fake wraps it in `{ kind: "ok" }` like the real fetcher.
 */
export type FakeEndpointAnswer = (call: FetchEndpointCall) => unknown;

export interface FakeFetchEndpoint {
  /** The fake, typed as the real fetcher — pass it to a helper taking one. */
  fetchEndpoint: FetchEndpoint;
  /** Every call, in order. */
  calls: FetchEndpointCall[];
  /**
   * A transport whose clients get THIS fetcher (`useFetchEndpoint`,
   * `useEndpoint`, `useEndpointMutation`, `fetchEndpointOver`) — mount it with
   * `withTransport(fake)`. Otherwise page-shaped (`testTransport`).
   */
  transport: Transport;
}

export interface FakeFetchEndpointOptions {
  /** Whether the computer is behind the fake transport (default true). */
  machine?: boolean;
  /** Overrides of the fake transport's other members (sockets, raw fetch). */
  transport?: Partial<Transport>;
}

/**
 * A fake `FetchEndpoint` that records each call and answers it with `answer`
 * (default: `undefined`, a void response) — and a transport that hands it to
 * every component under it. A `needsMachine` endpoint answers `unavailable`
 * without calling `answer` when `machine` is false, as the real one does.
 */
export function fakeFetchEndpoint(
  answer: FakeEndpointAnswer = () => undefined,
  options: FakeFetchEndpointOptions = {},
): FakeFetchEndpoint {
  const machine = options.machine ?? true;
  const calls: FetchEndpointCall[] = [];
  const fake = (async (
    endpoint: AnyEndpoint,
    params: unknown,
    opts?: FetchOpts<unknown, unknown>,
  ) => {
    if (endpoint.needsMachine !== undefined && !machine) {
      return {
        kind: "unavailable",
        message: unavailableMessage(endpoint.needsMachine),
      };
    }
    const recorded: FetchEndpointCall = {
      endpoint,
      route: endpoint.route,
      params,
      body: opts?.body,
      query: opts?.query,
      opts,
    };
    calls.push(recorded);
    const value: unknown = await answer(recorded);
    return endpoint.needsMachine === undefined ? value : { kind: "ok", value };
  }) as FetchEndpoint;
  const transport = testTransport({ ...options.transport, machine });
  installFakeFetcher(transport, fake);
  return { fetchEndpoint: fake, calls, transport };
}

/**
 * A `wrapper` (`render` / `renderHook`) mounting `target`'s transport above the
 * tree — a fake's, so every endpoint client under it answers from the fake.
 */
export function withTransport(
  target: Transport | FakeFetchEndpoint,
): (props: { children: ReactNode }) => ReactElement {
  return transportWrapper(
    "fetchEndpoint" in target ? target.transport : target,
  );
}
