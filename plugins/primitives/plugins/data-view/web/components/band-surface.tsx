import type { CSSProperties, ReactNode } from "react";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Sticky } from "@plugins/primitives/plugins/css/plugins/sticky/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { spaceLength } from "@plugins/primitives/plugins/css/plugins/space-ramp/core";
import { DATA_VIEW_HEADER_OFFSET_VAR } from "../../core";
import {
  DataViewControlsProvider,
  type DataViewControlsContextValue,
} from "./controls/controls-context";

/** The gap between a floating card (the aside) and the surface's edges. */
const GUTTER = "md";

/**
 * How a band surface lays out its three parts — the toolbar band, the
 * surface's `aside`, and the view body — and the one place the controls
 * context reaches beyond the band: it wraps the band AND the aside (two
 * providers of one value), never the body, so a view still sees only its
 * `DataViewRenderProps` contract.
 *
 * - **In-flow band, no aside**: band then body, exactly as always.
 * - **In-flow band + aside**: the aside is a left column (pinned to the
 *   scroller's top as the rows scroll), and the band and body share the rest.
 * - **Overlay arrangement** (`ToolbarArrangement.overlay`): the shell root
 *   fills its parent; the body renders in the surface's scroller, and the band
 *   (which positions itself, see `DataViewToolbar`) and the aside's floating
 *   card ride over it. A `fullBleed` view starts at the top-left edge, under
 *   them; any other view is inset by the band's measured height
 *   (`--dv-header-offset`, which its sticky group headers also pin at) and the
 *   aside's reach, so its first row clears the cards.
 */
export function BandSurface(props: {
  /** Whether the toolbar arrangement floats its band over the view. */
  overlay: boolean;
  /** The surface's side panel, or `undefined`. */
  aside: ReactNode;
  /** The active view type's `fullBleed`. */
  fullBleed: boolean;
  controls: DataViewControlsContextValue;
  /** Renders the toolbar band, given `ToolbarParts.asideInset`. */
  band: (asideInset: string) => ReactNode;
  /** The view body. */
  children: ReactNode;
}): ReactNode {
  const { overlay, aside, fullBleed, controls, band, children } = props;
  const [asideRef, { width: asideWidth }] = useElementSize();
  const hasAside = aside !== undefined;
  // The floating aside's reach from the left edge: its gutter plus its own
  // measured width. Beside an in-flow band the aside has a column of its own,
  // so the band and the body start past it already.
  const asideInset =
    overlay && hasAside
      ? `calc(${spaceLength(GUTTER)} + ${asideWidth}px)`
      : "0px";
  const bandNode = (
    <DataViewControlsProvider {...controls}>
      {band(asideInset)}
    </DataViewControlsProvider>
  );
  const asideNode = hasAside ? (
    <DataViewControlsProvider {...controls}>{aside}</DataViewControlsProvider>
  ) : null;

  if (overlay) {
    const bodyStyle: CSSProperties | undefined = fullBleed
      ? undefined
      : {
          paddingTop: `var(${DATA_VIEW_HEADER_OFFSET_VAR})`,
          paddingLeft: asideInset,
        };
    return (
      <>
        {/* The surface's one scroller (the root fills its parent, so the pane
            no longer scrolls the view). `isolate`: whatever stacking a view
            opens (a map's layers) stays under the floating band and aside. */}
        <Scroll fill isolate>
          <div
            className={fullBleed ? "h-full" : "min-h-full"}
            style={bodyStyle}
          >
            {children}
          </div>
        </Scroll>
        {bandNode}
        {asideNode ? (
          <Pin
            to="left"
            stretch
            offset={GUTTER}
            spanOffset={GUTTER}
            layer="nav"
            ref={asideRef}
          >
            {/* `overlay`: the floating-panel role (its own corners, ring and
                shadow), the same material as the band's floating cards. */}
            <Surface level="overlay" className="h-full">
              <Scroll className="h-full">{asideNode}</Scroll>
            </Surface>
          </Pin>
        ) : null}
      </>
    );
  }

  if (!asideNode) {
    return (
      <>
        {bandNode}
        {children}
      </>
    );
  }

  return (
    <Stack direction="row" gap="none" align="start">
      <Sticky edge="top" className={rigidClass()}>
        {asideNode}
      </Sticky>
      <Stack gap="none" className={fillClasses("x")}>
        {bandNode}
        {children}
      </Stack>
    </Stack>
  );
}
