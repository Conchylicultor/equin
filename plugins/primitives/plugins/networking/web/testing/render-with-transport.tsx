import {
  render,
  type RenderOptions,
  type RenderResult,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { SharedWebSocket } from "../shared-websocket";
import { TransportProvider, type Transport } from "../transport";

/**
 * A page-shaped transport for a test: same-origin sockets (`SharedWebSocket`),
 * the global `fetch` read at call time (so a fetch the test stubs answers),
 * assets loaded by their own path, the computer behind it, and its telemetry reported —
 * each overridable. Every call makes a new transport, so a per-transport store
 * (`transportScoped`) starts empty per test.
 */
export function testTransport(overrides: Partial<Transport> = {}): Transport {
  const transport: Transport = {
    socketUrl: (path) => path,
    openSocket: (url, options) => new SharedWebSocket(url, undefined, options),
    fetch: (input, init) => globalThis.fetch(input, init),
    servesUrls: true,
    machine: true,
    telemetry: true,
    ...overrides,
  };
  return transport;
}

/** A `wrapper` (`render` / `renderHook`) mounting `transport` above the tree. */
export function transportWrapper(
  transport: Transport,
): (props: { children: ReactNode }) => ReactElement {
  return function TransportWrapper({ children }) {
    return (
      <TransportProvider transport={transport}>{children}</TransportProvider>
    );
  };
}

export interface RenderWithTransportOptions extends RenderOptions {
  /** The subtree's transport — `testTransport()` when omitted. */
  transport?: Transport;
}

/**
 * `render(ui)` under a `<TransportProvider>` — what every component reading
 * `useTransport()` (the endpoints hooks, `useLive`) needs, since the context
 * has no default. A `wrapper` passed in is mounted inside the provider.
 */
export function renderWithTransport(
  ui: ReactElement,
  {
    transport = testTransport(),
    wrapper: Inner,
    ...options
  }: RenderWithTransportOptions = {},
): RenderResult & { transport: Transport } {
  const Outer = transportWrapper(transport);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Outer>{Inner ? <Inner>{children}</Inner> : children}</Outer>
  );
  return { ...render(ui, { ...options, wrapper }), transport };
}
