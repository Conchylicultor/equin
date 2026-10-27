import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * What a requester learns back from the chain above it.
 *
 * `granted` is the acknowledgement, and it exists because of an ordering
 * problem rather than as a nicety: a requester that measures in a layout effect
 * (`AdaptiveBar` does) would otherwise take its FIRST reading against the
 * un-grown box, since a `setState` from a child's layout effect flushes after
 * every layout effect of that commit. It is true only once every relay between
 * the requester and its row has actually applied the grow.
 *
 * `relays` is how many of them there were, and it is diagnosis rather than
 * mechanism: `0` means nothing above claimed the ask, while `n` means every box
 * this primitive can see relayed, so a box that swallows the grow is one it
 * cannot see — a hand-rolled wrapper in between.
 */
export interface GrowGrant {
  granted: boolean;
  relays: number;
}

/**
 * The registry a relay hands down to its descendants. Two balanced calls, never
 * a boolean: several boxes under one relay can want the slack at once, so the
 * relay counts them rather than latching a flag one unmount could clear for
 * all.
 */
interface GrowSink {
  register: () => void;
  unregister: () => void;
}

/**
 * The context value: the registry, plus what the chain above has answered.
 *
 * `sink` is a nested object rather than two more fields, and that shape is the
 * correctness argument. A descendant's registration effect depends on **`sink`,
 * not on this value** — the value is supposed to change (that is what `granted`
 * is for), and an effect keyed on it would re-run on every change, with the
 * cleanup's `unregister` taking the count straight back down: a relay that
 * flickers forever instead of settling. `sink` is memoised for the relay's whole
 * life, so keying on it makes that impossible rather than merely avoided. Same
 * reason [`popup-open`](../../../popup-open) memoises its sink on `[]`.
 */
interface GrowRelayValue extends GrowGrant {
  sink: GrowSink;
}

/**
 * No enclosing relay ⇒ asking is a silent no-op, and there is nothing to wait
 * for, so the ask is `granted` on the spot. That default is what makes a bar
 * rendered straight into its row (a pane header, the app tab strip) cost
 * nothing — and what makes the hook safe in a unit test with no scope at all.
 */
const NO_RELAY: GrowRelayValue = {
  sink: { register: () => {}, unregister: () => {} },
  granted: true,
  relays: 0,
};

const GrowRelayContext = createContext<GrowRelayValue>(NO_RELAY);

/** What a requester that is asking for nothing gets back. Module-level so the
 *  answer is referentially stable and never re-renders its caller. */
const NOT_ASKING: GrowGrant = { granted: true, relays: 0 };

/**
 * Publish "something under you needs the inline slack" to the nearest enclosing
 * {@link GrowRelay}, and read back whether the whole chain has granted it.
 *
 * Called by the widget that sizes ITSELF from the room it is given — today
 * `AdaptiveBar`, whose whole premise is that
 * `root.getBoundingClientRect().width` is a width it was handed rather than one
 * it produced. The point of the hook is that the widget asks for its own room:
 * there is no flag on a contribution three files away to forget.
 *
 * `useLayoutEffect`, not `useEffect`: the grow has to be on the box before the
 * browser paints, and before the requester's own measuring layout effect can
 * act on a reading taken without it.
 *
 * The registration IS the effect's subscription, so the release is the effect's
 * cleanup — going inactive and unmounting-while-active both travel the same
 * path. A release that got skipped would latch its relay grown forever.
 */
export function useRequestGrow(active: boolean): GrowGrant {
  const relay = useContext(GrowRelayContext);
  const sink = relay.sink;

  useLayoutEffect(() => {
    if (!active) return;
    sink.register();
    return () => sink.unregister();
  }, [sink, active]);

  // A requester that is not asking is not waiting on anything, and must not
  // report the chain's `relays` as if it were: nothing is being relayed.
  return active ? relay : NOT_ASKING;
}

/**
 * A box between a requester and its row. Grows when something under it asks,
 * and passes the ask on.
 *
 * Renders no DOM of its own — the render prop hands the answer to whatever box
 * the consumer already owns:
 *
 * ```tsx
 * <GrowRelay>
 *   {(growing) => (
 *     <div className={cn("flex min-w-0", growing && "flex-1")}>{children}</div>
 *   )}
 * </GrowRelay>
 * ```
 *
 * The render prop is deliberate for the same reason `PopupOpenScope`'s is:
 * providing the context and reading the aggregate are ONE component, so a
 * consumer cannot wire half of it — a relay nobody reads, or a reader with no
 * relay, would both look fine at author time.
 *
 * **Render the same element either way — only its classes may change.** Growing
 * is a styling answer, so a consumer that swaps the element (or its React type)
 * on `growing` unmounts everything under it, which releases the very ask that
 * made it grow, which un-grows it, which mounts it all back: the one way to hang
 * a page with this API. Pinned in `web/__tests__/grow-relay.test.tsx`.
 *
 * **It forwards even while growing.** `flex-1` yields pixels only if the box's
 * own parent has slack to share, so a relay that stopped here would fix one
 * link of the chain and leave the next one broken — which is the exact shape of
 * the bug this primitive replaces.
 *
 * A box that is **not** a relay is transparent, not a break: React context
 * passes straight through a plain `<div>`, so nothing between here and the
 * requester has to opt in. Such a box still fails to grow ITSELF, which no
 * bookkeeping can fix and which the requester's own runtime guard
 * (`adaptive-bar`'s `no-slack` probe) is there to catch. So wrap a box in a
 * relay only when the box can actually answer — a box that generates none
 * (`display: contents`) should stay out of the chain, or it inflates `relays`
 * with a link that applied nothing.
 *
 * A box whose role flips at runtime between a real box and `display: contents`
 * (slot-render's cell, which learns its host's flow after mounting) passes
 * `active={false}` while it is the latter: the relay then hands down the chain
 * above it unchanged — transparent, counting for nothing — while its element
 * stays put, so the flip remounts nothing under it.
 *
 * Nothing here is measured, so nothing can oscillate: `growing` counts MOUNTED
 * requesters, and no answer the requester computes from its new width can add
 * or remove one.
 */
export function GrowRelay({
  active = true,
  children,
}: {
  /** False: this box generates none right now, so it relays nothing. */
  active?: boolean;
  children: (growing: boolean) => ReactNode;
}): ReactNode {
  const above = useContext(GrowRelayContext);
  const [count, setCount] = useState(0);
  const growing = active && count > 0;

  // The relay is a requester too — this is the whole transitive half.
  const parent = useRequestGrow(growing);

  // Stable for the relay's whole life. See {@link GrowRelayValue} for why that
  // is a correctness requirement and not a memo micro-optimisation.
  const sink = useMemo<GrowSink>(
    () => ({
      register: () => setCount((n) => n + 1),
      unregister: () => setCount((n) => n - 1),
    }),
    [],
  );

  const value = useMemo<GrowRelayValue>(
    () =>
      active
        ? {
            sink,
            // Granted all the way up, or not granted: composing it here is what
            // makes the requester's single boolean mean "every box between me
            // and my row has applied the grow" rather than "the nearest one
            // did".
            granted: growing && parent.granted,
            relays: parent.relays + 1,
          }
        : // Inactive: a descendant's ask goes straight to the chain above (its
          // registration effect is keyed on the sink, so a flip moves it).
          above,
    [active, above, sink, growing, parent.granted, parent.relays],
  );

  return (
    <GrowRelayContext.Provider value={value}>
      {children(growing)}
    </GrowRelayContext.Provider>
  );
}

/**
 * The row. "The ask stops here — this box already has the width."
 *
 * `Line` (and so `Row` and `Bar`) installs one, because a single-line row is
 * the exact boundary the adaptive-bar contract names: *the growing cell of a
 * single-line row*. A host that owns such a row without being a `Line` — the
 * app tab strip, the prompt toolbar — installs one by hand.
 *
 * Forgetting one is the cheap direction: the ask escapes one relay further and
 * some ancestor cell grows into slack its rigid siblings did not want, which is
 * invisible. Forgetting the declaration this primitive replaces broke the bar.
 *
 * Not on `Stack`, and that is not an oversight: a `Stack direction="row"` is
 * just as often a grouping box BETWEEN the cell and the bar (Sonata's display
 * picker is exactly that), and stopping there would leave the cell never told.
 */
function GrowRelayStop({ children }: { children: ReactNode }): ReactNode {
  return (
    <GrowRelayContext.Provider value={NO_RELAY}>
      {children}
    </GrowRelayContext.Provider>
  );
}

GrowRelay.Stop = GrowRelayStop;
