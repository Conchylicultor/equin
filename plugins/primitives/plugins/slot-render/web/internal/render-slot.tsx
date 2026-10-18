import {
  type ControlSize,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { GrowRelay } from "@plugins/primitives/plugins/css/plugins/grow-relay/web";
import {
  createElement,
  Fragment,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  defineSlot,
  useRawContributions,
  UNSAFE_unsealSlotComponent,
  type Slot,
  type SealedComponent,
} from "@plugins/framework/plugins/web-sdk/core";
import type {
  CompanionFlag,
  Contribution,
} from "@plugins/framework/plugins/web-sdk/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type {
  SlotCompanions,
  SlotHandle,
} from "@plugins/framework/plugins/slot-declaration/core";
import {
  useSlotItemAttrs,
  useSlotItemMiddlewares,
  useSlotListMiddlewares,
} from "./registry";
import { DispatchOutcomeContext } from "./dispatch-outcome";
import { useSlotItemLayout } from "./item-layout";
import {
  flowAxis,
  layoutHost,
} from "@plugins/primitives/plugins/dom/plugins/layout-host/web";

/**
 * The ONE element a slot draws around each contribution — its box.
 *
 * Two roles in one element, deliberately:
 *
 * 1. **Layout.** Horizontal hosts get a `min-w-0` flex cell that relays the
 *    shrink-chain (so flexible text truncates instead of wrapping); everything
 *    else gets `display:contents`, a layout-neutral box.
 *
 *    `horizontal` is what the slot MEASURED off its own host; a host that
 *    relocates contributions into a different layout context (the `overflow`
 *    node type's dropdown panel) DECLARES the truth via `<SlotItemLayout>`, and
 *    the declaration wins. A component rather than a bare element for exactly
 *    that reason: the override has to be read where the contribution renders,
 *    not where its element was created.
 *
 *    `"host-owned"` is the declaration that says the host draws each item's box
 *    itself (an `AdaptiveBar` mints one stable container per occupant and moves
 *    it), so a cell here would be a SECOND, competing flex item beside it. It
 *    lands on the same `display:contents` branch as `"column"` — which is what
 *    `renderIsolated` produces, and is exactly why such hosts used to reach for
 *    it instead of `.Render`.
 *
 *    The GROW half of the same chain is not declared — it is **asked for**. A
 *    cell is rigid by default, which is right for the buttons and chips a chrome
 *    row is usually made of and wrong for the one contribution meant to expand
 *    into the row's slack: that contribution's box would shrink-wrap to its own
 *    content, so anything inside it that sizes itself from the room it is given
 *    (an `AdaptiveBar`, a truncating strip) reads its own content back as "the
 *    room I have" — a measurement that moves with the answer it produces. So the
 *    cell is a `GrowRelay`: the widget that needs the slack asks for it from
 *    where it is rendered, and the cell grows because it was asked. Nothing
 *    about the widget's need has to be restated on the contribution, several
 *    files away, for the two to agree.
 *
 *    `fill` remains as the explicit declaration — a contribution that wants the
 *    slack with no such widget inside it, and reorder's own (block-axis) reading
 *    of the same flag for its edit-mode wrapper.
 *
 * 2. **Identity.** It is where `SlotRender.ItemAttrs` contributors stamp what this
 *    contribution IS. The box is drawn by the slot but belongs to the
 *    contribution, and it is usually a little bigger than what the contribution
 *    paints inside it — so anything describing a contribution has to describe
 *    the box, or the slack around a small widget (most of what there is to point
 *    at when the widget is a 4px bar in a 24px row) answers for nobody.
 *
 * Its element type is stable across the post-measure `horizontal` flip, so React
 * reconciles each contribution subtree in place instead of tearing it down and
 * rebuilding it on every (re)mount.
 *
 * With no layout role AND nothing to stamp there is no element at all — the
 * paths that draw no cell (`.Mount`, `.Dispatch`) stay exactly as bare as they
 * were before any of this existed.
 */
function ContributionBox({
  slotId,
  contribution,
  cell,
  children,
}: {
  slotId: string;
  contribution: Contribution;
  cell?: { horizontal: boolean; fill: boolean };
  children: ReactNode;
}) {
  const declared = useSlotItemLayout();
  // The cell ITSELF when it lays out as a row, so the row branch below needs no
  // non-null assertion — `isRow` as a bare boolean tells the compiler nothing
  // about `cell`.
  const rowCell =
    cell && (declared !== null ? declared === "row" : cell.horizontal)
      ? cell
      : null;
  const attrs = useSlotItemAttrs({ slotId, contribution, boxless: !rowCell });
  if (!cell && !attrs) return <>{children}</>;
  // A `display:contents` box generates none, so it has nothing to grow and stays
  // out of the chain entirely — an ask crosses it for free (context passes
  // through), and counting it as a relay would report a link that applied
  // nothing.
  if (!rowCell)
    return (
      <div className="contents" {...attrs}>
        {children}
      </div>
    );
  return (
    <GrowRelay>
      {(asked) => (
        <div
          {...attrs}
          // eslint-disable-next-line layout/no-adhoc-layout -- one box whose DISPLAY flips at runtime between a flex cell and `display:contents`, on a React element type that must stay `div` across the flip (see the docstring: swapping the type tears the contribution subtree down, and <Line>/<Fill> are not `div` to React). No container primitive can express that, and the rigid cell is `min-w-0` WITHOUT `flex-1` on purpose — it relays the shrink-chain but must not grow, so it is not a <Fill>.
          className={
            rowCell.fill || asked
              ? "flex min-w-0 flex-1 items-center"
              : "flex min-w-0 items-center"
          }
        >
          {children}
        </div>
      )}
    </GrowRelay>
  );
}

export interface RenderSlotConfig<P> {
  docLabel?: (props: P & { id: string }) => string | undefined;
  /**
   * Declares this slot size-owning: `.Render` wraps every contribution in a
   * `ControlSizeProvider` of this density, so each contributed control inherits
   * one height (text → `control-sm`, icon → `control-icon-sm`, chip → its `sm`)
   * instead of declaring its own `size`. This is how a toolbar enforces a
   * consistent size across opaque contributions — declaring it here IS the
   * enforcement; a host cannot forget. Items should omit `size`; an explicit
   * `size` on a contribution still wins (escape hatch).
   *
   * This is the slot's DEFAULT density. A host that draws the same slot at a
   * different density (a roomier floating bar vs a compact docked strip) passes
   * `controlSize` to `.Render`, which overrides it for the WHOLE slot — every
   * item still shares one height, so the enforcement holds; only who picks the
   * height moves to the host that owns the surface.
   */
  controlSize?: ControlSize;
  /**
   * This slot is an internal part of one component — a list it draws inside
   * itself — not a row of its own. The one effect today: the slot may render
   * inside a pane title, which otherwise throws (the pane header is ONE slot;
   * a second one inside its title is a row its order file cannot see). Declare
   * it only for a component's own parts, never to place items beside a title.
   */
  partOfComponent?: true;
}

/**
 * The contributed item middlewares (`SlotRender.ItemMiddleware`: error-boundary
 * isolation, reorder item handle, …) folded around one contribution, lowest
 * priority outermost. A component rather than a loop in `applyItemMiddlewares`
 * because the middlewares are slot contributions, read with a hook — and
 * `applyItemMiddlewares` / `renderIsolated` are plain functions their callers
 * use from anywhere in a render.
 */
function ItemMiddlewares({
  slotId,
  contribution,
  children,
}: {
  slotId: string;
  contribution: Contribution;
  children: ReactNode;
}) {
  const itemMws = useSlotItemMiddlewares();
  let node = children;
  for (let i = itemMws.length - 1; i >= 0; i--) {
    const Mw = itemMws[i]!.Component;
    const captured = node;
    node = (
      <Mw slotId={slotId} contribution={contribution}>
        {captured}
      </Mw>
    );
  }
  return <>{node}</>;
}

/**
 * Wraps a rendered node in the contributed item middlewares and then in the
 * contribution's own box. Shared by `.Render`, `.Mount` and `.Dispatch`.
 *
 * The box goes OUTSIDE the middlewares and is applied here rather than by the
 * caller, so that every contribution rendered anywhere in the app ends up with
 * exactly one outermost element that the slot owns and that carries its
 * identity. `cell` is that box's layout role, which only `.Render` has.
 */
export function applyItemMiddlewares(
  node: ReactNode,
  slotId: string,
  contribution: Contribution,
  cell?: { horizontal: boolean; fill: boolean },
): ReactNode {
  return (
    <ContributionBox slotId={slotId} contribution={contribution} cell={cell}>
      <ItemMiddlewares slotId={slotId} contribution={contribution}>
        {node}
      </ItemMiddlewares>
    </ContributionBox>
  );
}

/**
 * Per-contribution render path shared by `.Render` (its default, non-`children`
 * branch) and `.Mount`: unseal the clean contribution's `component`, render it
 * as `<C/>`, and wrap in the item middlewares (error-boundary isolation). The
 * caller supplies the matched clean item and its raw stamped contribution.
 * Returns `null` when the clean item has no callable `component`.
 */
function renderContributionIsolated(
  clean: unknown,
  contribution: Contribution,
  slotId: string,
  cell?: { horizontal: boolean; fill: boolean },
): ReactNode {
  const component = (clean as { component?: unknown }).component;
  const node: ReactNode =
    typeof component === "function"
      ? ((C: ComponentType) => <C />)(
          UNSAFE_unsealSlotComponent(component as unknown as SealedComponent),
        )
      : null;
  return applyItemMiddlewares(node, slotId, contribution, cell);
}

interface RenderProps<P> {
  children?: (item: P) => ReactNode;
  subId?: string;
  /**
   * The density this host draws the slot at, overriding the slot's declared
   * `controlSize` for EVERY contribution (one height for the whole slot, never
   * per item). An explicit `size` on a contribution still wins.
   */
  controlSize?: ControlSize;
}

export interface RenderSlot<P> extends Slot<
  P & { id: string; excludeFromReorder?: boolean; fill?: boolean }
> {
  Render: ComponentType<
    RenderProps<
      P & { id: string; excludeFromReorder?: boolean; fill?: boolean }
    >
  >;
}

import { createContext } from "react";
export const RenderSlotSubIdContext = createContext<string | undefined>(
  undefined,
);

export function defineRenderSlot<P>(
  config?: RenderSlotConfig<P>,
): RenderSlot<P> {
  const slot = defineSlot<
    P & { id: string; excludeFromReorder?: boolean; fill?: boolean }
  >({ docLabel: config?.docLabel });

  const renderSlot = slot as unknown as RenderSlot<P>;
  // A render slot is visible and renders every contribution, so its order is
  // always user-curatable — there is no opt-out (a slot that shouldn't be
  // ordered is headless: `defineMountSlot`).
  renderSlot.meta = {
    kind: "render",
    reorderable: true,
    partOfComponent: config?.partOfComponent === true,
  };
  const declaredControlSize = config?.controlSize;

  renderSlot.Render = function SlotRender({
    children,
    subId,
    controlSize: hostControlSize,
  }: RenderProps<P & { id: string }>) {
    // The host's density wins over the slot's declared default.
    const controlSize = hostControlSize ?? declaredControlSize;
    const rawContributions = useRawContributions(slot);
    const cleanItems = slot.useContributions();
    const listMws = useSlotListMiddlewares();

    const cleanById = useMemo(
      () => new Map(cleanItems.map((item) => [item.id, item])),
      [cleanItems],
    );

    // Single-line discipline at the slot boundary: when the slot lays out
    // horizontally, every contribution is wrapped in a `min-w-0` cell so the
    // flex shrink-chain is never broken above a contribution. Without this,
    // each contributor would have to remember `min-w-0` on its own root or its
    // text silently wraps when the row is compressed. Fixed-size controls (the
    // `Button` primitive is `shrink-0`) are unaffected; flexible text shrinks
    // and truncates. Vertical lists are left untouched (zero layout change).
    // Orientation is read from the container at runtime — same sentinel
    // technique as the reorder list middleware — so slots declare nothing.
    const sentinelRef = useRef<HTMLSpanElement>(null);
    const [horizontal, setHorizontal] = useState(false);
    useLayoutEffect(() => {
      // The host is the box that lays the contributions out — past any
      // `display: contents` wrapper — and it is horizontal only when it is a
      // row flex container: a plain block or grid host treated as a row would
      // wrap each contribution in a `min-w-0` cell that collapses wide
      // block-level content to its min-content width.
      const sentinel = sentinelRef.current;
      const host = sentinel ? layoutHost(sentinel) : null;
      if (!host) return;
      setHorizontal(flowAxis(host) === "row");
    }, []);

    const renderItem = useCallback(
      (contribution: Contribution): ReactNode => {
        const cId = contribution.id as string | undefined;
        if (!cId) return null;
        const clean = cleanById.get(cId as (P & { id: string })["id"]);
        if (!clean) return null;

        // See `ContributionBox`: the measured host orientation (overridable by
        // a host that relocates contributions elsewhere) plus the
        // contribution's own claim on the row's slack.
        const cell = {
          horizontal,
          fill: (clean as { fill?: boolean }).fill === true,
        };
        const wrapped = children
          ? applyItemMiddlewares(
              children(clean as unknown as P & { id: string }),
              slot.id,
              contribution,
              cell,
            )
          : renderContributionIsolated(clean, contribution, slot.id, cell);
        // The key rides a Fragment rather than the box: the box is minted inside
        // `applyItemMiddlewares` (it has to sit outside the middlewares), and
        // `renderItem` returning a KEYED node is relied on by every caller that
        // maps it over a list — the reorder list middleware's passthrough path
        // included.
        return <Fragment key={cId}>{wrapped}</Fragment>;
      },
      [cleanById, children, horizontal],
    );

    const defaultRendering = <>{rawContributions.map((c) => renderItem(c))}</>;

    let result: ReactNode = defaultRendering;
    for (let i = listMws.length - 1; i >= 0; i--) {
      const Mw = listMws[i]!.Component;
      const captured = result;
      result = (
        <Mw
          slotId={slot.id}
          contributions={rawContributions}
          renderItem={renderItem}
        >
          {captured}
        </Mw>
      );
    }

    // Sentinel: a zero-layout (`display:none`) sibling of the contributions,
    // used to read the host container's flex-direction for the `min-w-0` cell
    // wrapping above. Rendered alongside `result` so it survives the reorder
    // middleware path (which renders its own item list, not `children`).
    const withSentinel = (
      <>
        <span ref={sentinelRef} className="hidden" aria-hidden />
        {result}
      </>
    );

    // Size-owning slot: one provider wraps the whole contribution list so every
    // item inherits one density — the host's (`.Render controlSize`) or else
    // the slot's declared default (see `controlSize` config).
    const withDensity =
      controlSize !== undefined ? (
        <ControlSizeProvider size={controlSize}>
          {withSentinel}
        </ControlSizeProvider>
      ) : (
        withSentinel
      );

    if (subId !== undefined) {
      return (
        <RenderSlotSubIdContext.Provider value={subId}>
          {withDensity}
        </RenderSlotSubIdContext.Provider>
      );
    }

    return withDensity;
  };

  return renderSlot;
}

/**
 * A headless contribution: mounts for side effects, renders nothing. Typed as
 * `=> null` so a component that returns JSX fails to compile — the structural
 * guarantee that a mount slot is non-visual.
 */
export type MountComponent<P = {}> = (props: P) => null;

export interface MountSlotConfig<P> {
  docLabel?: (props: P & { id: string }) => string | undefined;
}

export interface MountSlot<P> extends Slot<
  { id: string; component: MountComponent<P> } & P
> {
  /**
   * Mounts every contribution wrapped in item middlewares (error-boundary
   * isolation), no list/reorder middleware. Prop-less; renders null visually.
   */
  Mount: ComponentType;
}

/**
 * Headless sibling of `defineRenderSlot`: contributions mount for their side
 * effects and render nothing. `.Mount` wraps each contribution in the item
 * middlewares (error-boundary isolation) — exactly the per-item path `.Render`
 * uses — but applies NO list/reorder middleware, no `controlSize`, and no flex
 * sentinel, all irrelevant to invisible content. The component type is
 * constrained to `(props) => null` so a JSX-returning contributor fails to
 * compile.
 */
export function defineMountSlot<P = {}>(
  config?: MountSlotConfig<P>,
): MountSlot<P> {
  const slot = defineSlot<{ id: string; component: MountComponent<P> } & P>({
    docLabel: config?.docLabel,
  });

  const mountSlot = slot as unknown as MountSlot<P>;
  // Headless: its contributions paint nothing, so order is meaningless.
  mountSlot.meta = { kind: "mount", reorderable: false };

  mountSlot.Mount = function SlotMount() {
    const rawContributions = useRawContributions(slot);
    const cleanItems = slot.useContributions();

    const cleanById = useMemo(
      () => new Map(cleanItems.map((item) => [item.id as string, item])),
      [cleanItems],
    );

    return (
      <>
        {rawContributions.map((contribution) => {
          const cId = contribution.id as string | undefined;
          if (!cId) return null;
          const clean = cleanById.get(cId);
          if (!clean) return null;
          return (
            <Fragment key={cId}>
              {renderContributionIsolated(clean, contribution, slot.id)}
            </Fragment>
          );
        })}
      </>
    );
  };

  return mountSlot;
}

/**
 * A wrapper contribution: a component that renders `children`. Contributed to a
 * wrapper slot so the slot can fold it (and every sibling) around the host's
 * content — e.g. a per-surface React context Provider injected from a plugin the
 * host cannot import.
 */
export interface WrapContribution {
  id?: string;
  component: ComponentType<{ children: ReactNode }>;
}

export interface WrapperSlotConfig<P extends object> {
  docLabel?: (c: WrapContribution & P) => string | undefined;
}

export interface WrapperSlot<P extends object = {}> extends Slot<
  WrapContribution & P
> {
  /**
   * Folds every contributed wrapper OUTSIDE-IN around `children`, in
   * contribution order: the first contribution is the OUTERMOST wrapper, the
   * last is innermost (nearest `children`). With no contributions, returns
   * `children` unchanged.
   */
  Wrap: ComponentType<{ children: ReactNode }>;
}

/**
 * A slot whose contributions are `{children}` wrappers folded around the host's
 * content. Unlike `.Render`/`.Mount`, a wrapper slot does NOT render the
 * contributions as siblings — it nests them, so several plugins can each inject
 * a wrapping component (typically a React context Provider) above ONE shared
 * subtree. The canonical use: a plugin that the host can't import (a cycle)
 * needs a provider above the host's children; it contributes the provider here
 * and the host folds it in.
 *
 * NOT isolated by the item middlewares: a wrapper that crashes must crash the
 * subtree it wraps (a missing provider can't be "skipped" — its consumers would
 * throw anyway), and error boundaries don't compose with arbitrary providers.
 * This mirrors `Core.Root`'s direct unseal for the same structural reason.
 *
 * Fold direction: `reduceRight` makes `contributions[0]` the outermost wrapper —
 * matching `applyItemMiddlewares`, where the first (lowest-priority) middleware
 * also ends up outermost.
 */
export function defineWrapperSlot<P extends object = {}>(
  config?: WrapperSlotConfig<P>,
): WrapperSlot<P> {
  const slot = defineSlot<WrapContribution & P>({
    docLabel: config?.docLabel ? (c) => config.docLabel!(c) : undefined,
  });

  const wrapperSlot = slot as unknown as WrapperSlot<P>;
  // Contributions NEST rather than sit as siblings; there is no list to order.
  wrapperSlot.meta = { kind: "wrap", reorderable: false };

  wrapperSlot.Wrap = function SlotWrap({ children }: { children: ReactNode }) {
    const cleanItems = slot.useContributions();

    return cleanItems.reduceRight<ReactNode>((acc, clean) => {
      const component = (clean as { component?: unknown }).component;
      if (typeof component !== "function") return acc;
      const C = UNSAFE_unsealSlotComponent(
        component as unknown as SealedComponent,
      ) as ComponentType<{ children: ReactNode }>;
      return createElement(C, null, acc);
    }, children);
  };

  return wrapperSlot;
}

/**
 * The ONE dispatch precedence — exact string → RegExp → predicate, each in
 * registration order — shared by `.Dispatch` and `.useMatch`, so the component
 * a dispatch renders and the contribution a reader looks up cannot disagree.
 */
function matchDispatchIndex<Props>(
  items: readonly { match?: unknown }[],
  key: string,
  props: Props,
): number {
  let i = items.findIndex(
    (c) => typeof c.match === "string" && c.match === key,
  );
  if (i < 0) {
    i = items.findIndex((c) => c.match instanceof RegExp && c.match.test(key));
  }
  if (i < 0) {
    i = items.findIndex(
      (c) =>
        typeof c.match === "function" &&
        (c.match as (p: Props) => boolean)(props),
    );
  }
  return i;
}

export interface DispatchContribution<Props, Key extends string> {
  /**
   * Plain string = exact match; RegExp = pattern match; predicate = arbitrary
   * test against the render props. Precedence: exact string → RegExp →
   * predicate (in registration order).
   */
  match: Key | RegExp | ((props: Props) => boolean);
  component: ComponentType<Props>;
}

export interface DispatchSlotConfig<
  Props,
  Key extends string,
  Extra extends object,
> {
  /** Project the dispatch key out of the render props. */
  key: (props: Props) => Key;
  /** Rendered (and isolated) when nothing matches. */
  fallback?: ComponentType<Props>;
  docLabel?: (
    c: DispatchContribution<Props, Key> & Extra,
  ) => string | undefined;
}

export interface DispatchSlot<
  Props,
  Key extends string = string,
  Extra extends object = {},
> extends Slot<DispatchContribution<Props, Key> & Extra> {
  Dispatch: ComponentType<Props>;
  /**
   * A reader of the contribution `.Dispatch` would render for `props` — its
   * `Extra` fields (what a contribution declares beside its component), or
   * `undefined` when the fallback would render. For a host that needs a
   * contribution's data without rendering it.
   */
  useMatch: Hook<() => (props: Props) => Extra | undefined>;
}

/**
 * `companions` opts the slot into companion contributions, exactly as on
 * `defineSlot` — typically KEYED (`{ key: "match", space }`), so a contribution
 * serving one key ships only in bundles that use that key.
 */
export function defineDispatchSlot<
  Props,
  Key extends string = string,
  Extra extends object = {},
>(
  config: DispatchSlotConfig<Props, Key, Extra> & {
    companions: SlotCompanions;
  },
): DispatchSlot<Props, Key, Extra & CompanionFlag>;
export function defineDispatchSlot<
  Props,
  Key extends string = string,
  Extra extends object = {},
>(
  config: DispatchSlotConfig<Props, Key, Extra>,
): DispatchSlot<Props, Key, Extra>;
export function defineDispatchSlot<
  Props,
  Key extends string = string,
  Extra extends object = {},
>(
  config: DispatchSlotConfig<Props, Key, Extra> & {
    companions?: SlotCompanions;
  },
): DispatchSlot<Props, Key, Extra> {
  const slot = defineSlot<DispatchContribution<Props, Key> & Extra>({
    docLabel: config.docLabel ? (c) => config.docLabel!(c) : undefined,
  });

  const dispatchSlot = slot as unknown as DispatchSlot<Props, Key, Extra>;
  // Exactly one contribution renders and contributions carry no id, so there is
  // nothing to order. `defineOrderedDispatchSlot` overwrites this.
  dispatchSlot.meta = config.companions
    ? { kind: "dispatch", reorderable: false, companions: config.companions }
    : { kind: "dispatch", reorderable: false };

  dispatchSlot.useMatch = function useDispatchMatch() {
    const cleanItems = slot.useContributions();
    return useCallback(
      (props: Props) => {
        const i = matchDispatchIndex(cleanItems, config.key(props), props);
        return i < 0 ? undefined : (cleanItems[i] as unknown as Extra);
      },
      [cleanItems],
    );
  };

  dispatchSlot.Dispatch = function SlotDispatch(props: Props) {
    const rawContributions = useRawContributions(slot);
    const cleanItems = slot.useContributions();

    const key = config.key(props);

    const matchedIndex = matchDispatchIndex(cleanItems, key, props);

    const matchedItem =
      matchedIndex >= 0 ? cleanItems[matchedIndex] : undefined;
    const Component = matchedItem
      ? UNSAFE_unsealSlotComponent(
          matchedItem.component as SealedComponent<Props>,
        )
      : config.fallback;
    // Index correspondence: both `cleanItems` and `rawContributions` come from
    // the registry's one list for this slot (clean is a positional `.map` of raw,
    // memoized on that list — slots.ts `sealed`),
    // so `rawContributions[matchedIndex]` is the stamped Contribution carrying
    // `_pluginId` for the error-boundary middleware. The fallback path has no
    // contribution, so synthesize a minimal one with a generic boundary label.
    const contribution: Contribution =
      matchedIndex >= 0
        ? rawContributions[matchedIndex]!
        : ({ _slot: slot } as Contribution);

    const node: ReactNode = Component
      ? createElement(Component as ComponentType<object>, props as object)
      : null;

    // Publish the outcome to the subtree so a descendant can react to "nothing
    // handled this" without every fallback threading a prop by hand. Memo deps
    // are the BOOLEAN `matched`, never `matchedIndex`: reordering contributions
    // must not churn the value for consumers that only care whether anything
    // matched at all. The provider wraps OUTSIDE `applyItemMiddlewares` so the
    // outcome is still readable from inside an error-boundary fallback.
    const matched = matchedIndex >= 0;
    const outcome = useMemo(
      () => ({ slotId: slot.id, key, matched }),
      [key, matched],
    );

    return createElement(
      DispatchOutcomeContext.Provider,
      { value: outcome },
      applyItemMiddlewares(node, slot.id, contribution),
    );
  };

  return dispatchSlot;
}

/**
 * A dispatch contribution that also participates in the reorder config-tree
 * system. Identical to `DispatchContribution`, plus a structurally required
 * `id: string`: the reorder entryKey is `pluginId:id`, so a dispatch slot can
 * only enter the reorderable-slots manifest once every contribution carries an
 * id. `excludeFromReorder` mirrors the render-slot escape hatch.
 */
export interface OrderedDispatchContribution<
  Props,
  Key extends string,
> extends DispatchContribution<Props, Key> {
  id: string;
  excludeFromReorder?: boolean;
}

export interface OrderedDispatchSlot<
  Props,
  Key extends string = string,
  Extra extends object = {},
> extends Slot<OrderedDispatchContribution<Props, Key> & Extra> {
  Dispatch: ComponentType<Props>;
}

/**
 * Ordered-dispatch sibling of `defineDispatchSlot`: the runtime is literally
 * `defineDispatchSlot` — same registration, same `.Dispatch` single-match
 * selection, same item-middleware isolation. ONLY the contribution TYPE differs:
 * contributions must carry an `id: string` (`OrderedDispatchContribution`).
 *
 * That id is what lets the slot participate in the reorder config-tree system.
 * A plain dispatch slot is absent from the reorderable-slots manifest and its
 * contributions carry no id, so it can neither be grouped nor reordered. An
 * ordered-dispatch slot is `reorderable` in its own `meta` and therefore owes an
 * authored config override, exactly like a render slot — but it renders via
 * `.Dispatch` (one match), not `.Render` (all contributions). Consumers that
 * want the config order (grouped menus, ordered pickers) read that order through
 * the reorder read hook; the slot itself keeps pure dispatch semantics.
 *
 * Because the runtime IS `defineDispatchSlot`, this used to be a TS cast and
 * nothing else: the slot's own identity existed only as the spelling of this
 * function's name in source text, recoverable by grep and by nothing else. It
 * now overwrites `meta`, so the fact is on the object.
 */
export function defineOrderedDispatchSlot<
  Props,
  Key extends string = string,
  Extra extends object = {},
>(
  config: DispatchSlotConfig<Props, Key, Extra & { id: string }>,
): OrderedDispatchSlot<Props, Key, Extra> {
  const slot = defineDispatchSlot<Props, Key, Extra & { id: string }>(
    config,
  ) as unknown as OrderedDispatchSlot<Props, Key, Extra>;
  slot.meta = { kind: "ordered-dispatch", reorderable: true };
  return slot;
}

/**
 * Render one contribution's component wrapped in the contributed item middlewares
 * (error-boundary isolation). For bespoke selection that `.Render`/`.Dispatch`
 * can't express (e.g. a tiered `supports()` probe). STILL ISOLATED — not an
 * escape from isolation.
 */
export function renderIsolated(
  slot: SlotHandle,
  contribution: Contribution,
  props?: object,
): ReactNode {
  const Component = UNSAFE_unsealSlotComponent(
    (contribution as unknown as { component: SealedComponent }).component,
  );
  return applyItemMiddlewares(
    createElement(Component as ComponentType<object>, props),
    slot.id,
    contribution,
  );
}
