import {
  createContext,
  useContext,
  useEffect,
  type ReactElement,
  type ReactNode,
} from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";

/**
 * A rung on the ladder — a form a widget renders ITSELF as. `"row"` is a
 * labelled row in the overflow panel (see `PanelActionRow`), NOT a menu item:
 * the panel is always mounted, so it is a plain dialog and never a
 * `role="menu"`.
 */
export type ActionForm = "full" | "compact" | "row";

/** How eagerly a widget gives up room relative to its neighbours. */
export type YieldEagerness = "never" | "late" | "normal" | "early";

export interface ShrinkLadder {
  /** Smaller forms this widget can render, widest first. `"full"` is rung 0, implicit. */
  shrinksTo?: readonly Exclude<ActionForm, "full">[];
  /** Default `"normal"`. `"never"` pins the widget at full. */
  yields?: YieldEagerness;
  /**
   * Items that only make sense whole leave the row together: once one item of
   * a cohort is relocated, every item of it is — a site's page links, where a
   * menu holding half the pages and a row holding the other half reads as two
   * broken navigations. A name, shared by the cohort's members. Default `null`
   * (no cohort: the item leaves on its own).
   */
  cohort?: string | null;
}

/**
 * The per-item duplex channel a region (the adaptive bar) provides: the form it
 * assigned flows down, the widget's ladder and holds flow back up.
 *
 * A region mounts ONE provider per item, so `declare` needs no item id — the
 * channel instance IS the item's identity.
 */
export interface ItemFormChannel {
  /** The form the region assigned to this item. */
  readonly form: ActionForm;
  /**
   * Widget → region. Call from an effect; returns a release. Idempotent per
   * item: a second declaration for the same item replaces the first rather than
   * adding a second ladder, so a widget that re-declares (its eagerness is
   * per-instance and dynamic — only the *focused* tab says `"never"`) never
   * leaves a stale rung behind.
   */
  declare(ladder: Required<ShrinkLadder>): () => void;
  /** Widget → region: freeze this item's assignment. Returns a release. */
  hold(): () => void;
}

/**
 * `null` — no adaptive bar above — is the overwhelmingly common case: ~90
 * plugins render an `IconButton` in ordinary chrome. It must cost nothing and
 * behave exactly as it did before this seam existed, so the hooks below turn
 * into a constant `"full"` and a no-op registration.
 */
const ItemFormChannelContext = createContext<ItemFormChannel | null>(null);

/**
 * Hands one item its channel. Mounted by the region around a single item's
 * subtree — never around a group, because the channel carries that item's own
 * assignment and any second widget under it would read the wrong one.
 */
export function ActionFormProvider({
  channel,
  children,
}: {
  channel: ItemFormChannel;
  children: ReactNode;
}): ReactElement {
  return (
    <ItemFormChannelContext.Provider value={channel}>
      {children}
    </ItemFormChannelContext.Provider>
  );
}

/**
 * Keeps the controls inside a widget from speaking for its item.
 *
 * A region mounts one channel per ITEM, and every `useActionForm` below it
 * declares into that one channel — so a widget that declares its own ladder
 * and renders `IconButton`s inside itself (a stepper's ‹ ›) has them declare
 * `["row"]` over it, and whichever effect ran last decides what the item can
 * shrink to. Wrap the widget's inner controls in this: below it there is no
 * region, so they render at `"full"` and declare nothing, and the widget's own
 * ladder is the item's.
 */
export function ActionFormShield({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  return (
    <ItemFormChannelContext.Provider value={null}>
      {children}
    </ItemFormChannelContext.Provider>
  );
}

/** Shared empty rung list, so `useLatestRef`'s value is stable when nothing is declared. */
const NO_RUNGS: readonly Exclude<ActionForm, "full">[] = [];

/**
 * Declare this widget's ladder AND read back the form the region picked.
 * One hook, both directions — you cannot wire half of it (a declaration nobody
 * reads, or a read nobody declared for, would both look fine at author time).
 *
 * ```tsx
 * const form = useActionForm({ shrinksTo: ["compact"], yields: "early" });
 * if (form === "compact") return <IconButton icon={Icon} label="Volume" onClick={toggleMute} />;
 * return <VolumeSlider …/>;
 * ```
 *
 * INVARIANT — **the returned form is one this caller declared, or `"full"`.**
 * It is enforced here rather than trusted of the region, for two reasons. The
 * cheap one: the assignment arrives through context, so it is already committed
 * on the render where the declaration is still only queued in an effect, and a
 * widget that had not yet said "I can be a labelled row" must not be asked to be
 * one for that one frame. The load-bearing one: this is what makes "a jog wheel
 * becomes a labelled row" structurally unrepresentable rather than a rule
 * written in prose — no region, present or future, can hand a form to a widget
 * that never offered it.
 *
 * A widget that calls this with nothing gets a one-rung ladder: the region may
 * leave it alone or relocate it as itself, never transform it. Calling it not at
 * all is the same thing, so a contributor who never heard of this seam is safe.
 *
 * THE OTHER HALF OF THE PROMISE — **declaring a form commits you to rendering
 * something as it.** Returning `null` when the region hands you the form you
 * asked for is not "shrinking to nothing"; it is a control disappearing, which
 * is the one transformation this seam exists to prevent. A region cannot tell
 * that apart from a contribution that renders nothing at all until it has
 * already put the widget there, so it costs a wasted round and a filed report
 * (`adaptive-bar`'s `empty-rung`) before it stops offering the form.
 *
 * Which means a form you cannot render **right now** — data still loading, a
 * permission missing, an empty list — should not be declared right now. The
 * declaration is a live subscription re-run whenever the ladder's value changes,
 * so `shrinksTo: items.length > 0 ? ["compact"] : []` is both legal and the
 * intended spelling; a region invalidates everything it had learned about a
 * widget whose rung set really changed.
 */
export function useActionForm(ladder?: ShrinkLadder): ActionForm {
  const channel = useContext(ItemFormChannelContext);

  // Normalize once, here, so the region only ever sees a complete ladder and
  // never re-derives the defaults itself.
  const shrinksTo = ladder?.shrinksTo ?? NO_RUNGS;
  const yields = ladder?.yields ?? "normal";
  const cohort = ladder?.cohort ?? null;

  // Callers pass an object literal inline (`useActionForm({ shrinksTo: ["row"] })`),
  // so object identity churns every render and is useless as an effect dep. The
  // ladder's VALUE is a short string, so serialize it and key the effect on
  // that; the effect then reads the value itself off the latest ref, which the
  // key is a faithful serialization of.
  const ladderKey = `${shrinksTo.join(",")}|${yields}|${cohort ?? ""}`;
  const ladderRef = useLatestRef<Required<ShrinkLadder>>({
    shrinksTo,
    yields,
    cohort,
  });

  useEffect(() => {
    if (!channel) return;
    // The registration IS the subscription, so the release is the cleanup:
    // re-declaring and unmounting take the same path, and a widget that leaves
    // the tree cannot strand its rung in the region's ledger.
    return channel.declare(ladderRef.current);
    // `shrinksTo` / `yields` are deliberately absent: they are read from the
    // ref, and `ladderKey` is exactly their value.
  }, [channel, ladderKey, ladderRef]);

  const assigned = channel?.form ?? "full";
  return assigned === "full" || shrinksTo.includes(assigned)
    ? assigned
    : "full";
}

/**
 * Freeze this item's assignment while a live interaction is in flight, so the
 * region re-fits everything *around* it instead of moving it under the user's
 * finger. The region stores the target placement rather than discarding it —
 * the release itself triggers a re-fit, so "deferred forever" cannot happen.
 *
 * Only for what survives the pointer release (an inertial fling's coast): the
 * bar pins the item under an active pointer by itself, from its own capture
 * handlers, with no author opt-in.
 */
export function useHoldShrink(active: boolean): void {
  const channel = useContext(ItemFormChannelContext);

  useEffect(() => {
    if (!active || !channel) return;
    return channel.hold();
  }, [active, channel]);
}
