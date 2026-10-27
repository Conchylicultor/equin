import {
  createContext,
  useContext,
  useMemo,
  type Provider,
  type ReactNode,
} from "react";

/** A bag of `data-*` attributes to re-stamp onto portaled content.
 *
 *  Portals relocate their subtree to `document.body`, severing it from the DOM
 *  ancestry that carries ancestry-derived signals — the scoped theme, the plugin
 *  contribution lineage the element-picker reads off marker spans, the containing
 *  pane id. Each such signal is lost the moment content portals out. The fix is
 *  one bridge: a signal flows across the portal as React **context** (which
 *  crosses portals, unlike DOM ancestry) and every portal surface re-stamps the
 *  whole bag back onto its positioner so DOM-walking consumers see it again.
 *
 *  This is the generic substrate. Contributors register one attribute via
 *  {@link PortalForwardProvider}; portal surfaces consume the merged map via
 *  {@link usePortalForwardedAttrs}. Neither side knows about the other, so a new
 *  forwarded signal is a single provider and **zero** portal-surface edits — the
 *  collection/consumer split that keeps "portals sever ancestry" from being a
 *  bug re-fixed once per signal. Theme scope and plugin lineage are the first two
 *  contributors. */
export type PortalForwardedAttrs = Record<string, string>;

/** The two bags a portal can re-stamp. They differ only by a value's
 *  {@link ForwardReach}: a `region` value is in `region` alone (`popup` keeps
 *  the value from above), a `popups` value in `popup` alone. */
interface ForwardedBags {
  region: PortalForwardedAttrs;
  popup: PortalForwardedAttrs;
}

declare const FORWARD_SCOPE: unique symbol;

/** The forwarded bags as {@link usePortalForward} merged them — the only value
 *  {@link PortalForwardScope} accepts, so a scope can only ever extend the one
 *  above it, never replace it with a hand-built bag. */
export type PortalForwardScopeValue = ForwardedBags & {
  readonly [FORWARD_SCOPE]: true;
};

const PortalForwardContext = createContext<PortalForwardScopeValue>({
  region: {},
  popup: {},
} as unknown as PortalForwardScopeValue);

/** The merged `data-*` attributes a POPUP re-stamps onto its portaled
 *  positioner/root — a popover, menu, dialog, tooltip or overlay opened from
 *  here. A `region`-reach value is not in it: a popup is not part of
 *  the region it was opened from. */
export function usePortalForwardedAttrs(): PortalForwardedAttrs {
  return useContext(PortalForwardContext).popup;
}

/** The merged `data-*` attributes for content that is portaled but still part
 *  of this region — an adaptive bar's item, which renders through a portal
 *  whether it sits in the bar or in its overflow panel. Includes every
 *  `region`-reach value, and no `popups`-reach one. */
export function useRegionForwardedAttrs(): PortalForwardedAttrs {
  return useContext(PortalForwardContext).region;
}

/** Which portaled content a forwarded value reaches:
 *  - `all` — content relocated within the region and popups opened from it;
 *  - `region` — the region only: a popup opened from inside keeps the value
 *    from above. A theme sub-theme is the case — it restyles a page, not the
 *    menus opened from it;
 *  - `popups` — popups only: content relocated within the region keeps the
 *    value from above. The app launcher is the case — its trigger sits in the
 *    app's header, while the grid it opens is chrome. */
export type ForwardReach = "all" | "region" | "popups";

/** The bags below a forwarded `data-*` attribute: the inherited ones with
 *  `name` merged in (nearest wins per key); an `undefined` value is a no-op so
 *  callers forward conditionally without branching. Provide the result with
 *  {@link PortalForwardScope}. The hook form is for a component that is a
 *  provider among other things (a slot item middleware), so forwarding costs it
 *  one fiber — {@link PortalForwardProvider} is the plain one. */
export function usePortalForward(
  name: string,
  value: string | undefined,
  reach: ForwardReach = "all",
): PortalForwardScopeValue {
  const parent = useContext(PortalForwardContext);
  return useMemo(() => {
    if (value === undefined) return parent;
    return {
      region:
        reach === "popups"
          ? parent.region
          : { ...parent.region, [name]: value },
      popup:
        reach === "region" ? parent.popup : { ...parent.popup, [name]: value },
    } as PortalForwardScopeValue;
  }, [parent, name, value, reach]);
}

/** Provides what {@link usePortalForward} merged. */
export const PortalForwardScope: Provider<PortalForwardScopeValue> =
  PortalForwardContext.Provider;

/** Register one forwarded `data-*` attribute for portaled descendants. Merges
 *  into the inherited bag (nearest provider wins per key); an `undefined` value
 *  is a no-op so callers forward conditionally without branching. */
export function PortalForwardProvider({
  name,
  value,
  reach = "all",
  children,
}: {
  name: string;
  value: string | undefined;
  reach?: ForwardReach;
  children: ReactNode;
}) {
  const merged = usePortalForward(name, value, reach);
  return (
    <PortalForwardContext.Provider value={merged}>
      {children}
    </PortalForwardContext.Provider>
  );
}
