import { useTransport, type Transport } from "./transport";

/**
 * One value per transport, made on first ask and kept for as long as the
 * transport lives — the store, cache or client a transport-agnostic module
 * needs one of per server it talks to (the bound endpoint fetcher, a live-state
 * pipeline, a per-transport ledger). Weakly keyed, so a transport nothing holds
 * any more takes its value with it.
 */
export interface TransportScoped<T> {
  /** The value for `transport`, made by the factory on its first ask. */
  of(transport: Transport): T;
}

/** A {@link TransportScoped} whose values `make` builds, one per transport. */
export function transportScoped<T>(
  make: (transport: Transport) => T,
): TransportScoped<T> {
  const values = new WeakMap<Transport, T>();
  return {
    of(transport) {
      if (values.has(transport)) return values.get(transport) as T;
      const value = make(transport);
      values.set(transport, value);
      return value;
    },
  };
}

/** `scoped`'s value for the enclosing subtree's transport (`useTransport()`). */
export function useTransportScoped<T>(scoped: TransportScoped<T>): T {
  return scoped.of(useTransport());
}
