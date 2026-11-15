import {
  createContext,
  createElement,
  useContext,
  type ReactNode,
} from "react";
import { REQUEST_ISSUER_HEADER, type RequestIssuer } from "../core";
import type { Transport } from "./transport";

/**
 * `init` with {@link REQUEST_ISSUER_HEADER} naming `issuer` — kept when the
 * request already names one and `override` is false (the page's transport
 * stamps `page` under whatever a scope's wrapper stamped first). A `Request`
 * input's own headers are carried over: an `init.headers` replaces them.
 */
export function stampIssuer(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  issuer: RequestIssuer,
  override: boolean,
): RequestInit {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  if (override || !headers.has(REQUEST_ISSUER_HEADER))
    headers.set(REQUEST_ISSUER_HEADER, issuer);
  return { ...init, headers };
}

/** The scope issuer of the enclosing subtree; `null`: the page's own. */
const RequestIssuerContext = createContext<RequestIssuer | null>(null);

/**
 * Names `issuer` as who issues every page-origin request of `children`: a
 * `<TransportProvider>` below it handing out the PAGE's transport hands out
 * one that stamps `issuer` instead of `page` — so a scope that reaches the
 * page's server (it must not) says so on the request. Mounted by a scope
 * with a server of its own (`DemoScope`).
 */
export function RequestIssuerScope({
  issuer,
  children,
}: {
  issuer: RequestIssuer;
  children: ReactNode;
}) {
  return createElement(
    RequestIssuerContext.Provider,
    { value: issuer },
    children,
  );
}

/** The scope issuer of the enclosing subtree, `null` outside every scope. */
export function useRequestIssuer(): RequestIssuer | null {
  return useContext(RequestIssuerContext);
}

const issued = new WeakMap<Transport, Map<RequestIssuer, Transport>>();

/**
 * `transport` with every fetch stamped as issued by `issuer` — one object per
 * (transport, issuer), so the clients a transport keys (`transportScoped`)
 * stay one per subtree.
 */
export function issuedBy(
  transport: Transport,
  issuer: RequestIssuer,
): Transport {
  let byIssuer = issued.get(transport);
  if (byIssuer === undefined) {
    byIssuer = new Map();
    issued.set(transport, byIssuer);
  }
  let wrapped = byIssuer.get(issuer);
  if (wrapped === undefined) {
    wrapped = {
      ...transport,
      fetch: (input, init) =>
        transport.fetch(input, stampIssuer(input, init, issuer, true)),
    };
    byIssuer.set(issuer, wrapped);
  }
  return wrapped;
}
