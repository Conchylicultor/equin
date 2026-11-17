import {
  createElement,
  use,
  useLayoutEffect,
  useSyncExternalStore,
  type Context,
  type ReactNode,
} from "react";

/**
 * A context its owner lets be relayed: an opaque token, minted by the owner
 * with {@link relayOf}, so the context object itself stays private (its
 * readers keep going through the owner's hooks).
 */
export interface Relayed {
  readonly __relayed: "context-relay";
}

interface RelayedContext extends Relayed {
  readonly context: Context<unknown>;
}

/** Mints the relay token of a context its owner holds. */
export function relayOf<T>(context: Context<T>): Relayed {
  const token: RelayedContext = {
    __relayed: "context-relay",
    context: context as Context<unknown>,
  };
  return token;
}

function contextOf(relayed: Relayed): Context<unknown> {
  return (relayed as RelayedContext).context;
}

type Captured = readonly (readonly [Context<unknown>, unknown])[];

/**
 * The captured values of a set of relayed contexts, as an external store:
 * written by one {@link RelayCapture}, read by any number of
 * {@link RelayProvide}.
 */
export interface RelayLink {
  readonly __relayLink: "context-relay";
}

class Link implements RelayLink {
  readonly __relayLink = "context-relay" as const;
  private captured: Captured | null = null;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = (): Captured | null => this.captured;

  publish(next: Captured): void {
    const prev = this.captured;
    if (
      prev !== null &&
      prev.length === next.length &&
      prev.every(([c, v], i) => c === next[i]![0] && Object.is(v, next[i]![1]))
    ) {
      return;
    }
    this.captured = next;
    for (const listener of [...this.listeners]) listener();
  }
}

export function createRelayLink(): RelayLink {
  return new Link();
}

function linkOf(link: RelayLink): Link {
  if (!(link instanceof Link)) {
    throw new Error("context-relay: not a link made by createRelayLink()");
  }
  return link;
}

/**
 * Where the state lives: reads every relayed context here and publishes the
 * values to `link` on each commit that changed one. Renders nothing.
 */
export function RelayCapture({
  link,
  relays,
}: {
  link: RelayLink;
  relays: readonly Relayed[];
}): ReactNode {
  "use no memo";
  // "use no memo" -- the captured values are read with `use` in a loop over
  // data (the relay set); compiled, the capture was memoized on `relays` alone
  // and never saw a context change again — the view kept the first values.
  const target = linkOf(link);
  const captured: (readonly [Context<unknown>, unknown])[] = [];
  for (const r of relays) {
    const context = contextOf(r);
    captured.push([context, use(context)]);
  }
  useLayoutEffect(() => target.publish(captured));
  return null;
}

/**
 * Where the view is: provides every context captured into `link` around
 * `children`, following each change; `fallback` until the first capture.
 */
export function RelayProvide({
  link,
  fallback,
  children,
}: {
  link: RelayLink;
  fallback: ReactNode;
  children: ReactNode;
}): ReactNode {
  const source = linkOf(link);
  const captured = useSyncExternalStore(
    source.subscribe,
    source.snapshot,
    source.snapshot,
  );
  if (captured === null) return fallback;
  return captured.reduceRight<ReactNode>(
    (inner, [context, value]) =>
      createElement(context.Provider, { value }, inner),
    children,
  );
}
