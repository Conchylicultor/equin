import { Icon } from "@plugins/ui/plugins/icons/web";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import {
  Button,
  Sidebar,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  type SidebarToggleIcons,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Bar } from "@plugins/primitives/plugins/bar/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import {
  SurfaceChromeContext,
  type PaneObject,
} from "@plugins/primitives/plugins/pane/web";
import { useMemo, type ReactNode } from "react";
import {
  useRawContributions,
  type Contribution,
} from "@plugins/framework/plugins/web-sdk/core";
import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import {
  renderIsolated,
  type RenderSlot,
} from "@plugins/primitives/plugins/slot-render/web";
import type { SidebarFramingProps } from "../../core";
import { AppShell } from "../slots";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { SidebarItem } from "./sidebar-nav-item";
import { useSurfaceTabId } from "@plugins/primitives/plugins/scope/plugins/surface-id/web";
import { AppShellBrand, useHasAppShellBrand } from "./app-shell-brand";
import { useRecordSidebarDrawn } from "../internal/sidebar-presence";

/**
 * Where a nav entry goes, as DATA: a pane and its params, opened as the root
 * of the route. Build one with {@link opensPane}, which type-checks `params`
 * against the pane's own.
 *
 * Being data is what lets the shell answer "is this entry the current one?":
 * the row is active exactly while the route's ROOT pane is this pane. A
 * callback cannot say where it goes, so an `onClick` entry is never marked.
 */
export interface SidebarNavTarget {
  // Params are checked by `opensPane` at construction; stored erased.
  pane: PaneObject<any, any, any, any>;
  params: Record<string, string>;
}

/** A {@link SidebarNavTarget} for `pane` opened with `params`. */
export function opensPane<Params>(
  pane: PaneObject<Params, any, any, any>,
  params: NoInfer<Params>,
): SidebarNavTarget {
  return { pane, params: params as Record<string, string> };
}

/**
 * A nav entry — the common case. Pure data: the shell draws the row
 * ({@link SidebarItem}), so every nav entry in every app shares one inset,
 * height, icon size and hover by construction. `badge` is an optional
 * attention overlay pinned to the icon's corner; it renders `null` when there
 * is nothing to flag. `component` is forbidden.
 *
 * What a click does is one of two arms: `opens` (a pane, as data — the shell
 * opens it as the route root AND highlights the row while that pane is the
 * root) xor `onClick` (anything else; never highlighted, because a callback
 * cannot say where it goes).
 */
export type AppShellSidebarNav = {
  title: string;
  icon: IconRef;
  badge?: React.ComponentType;
  component?: never;
} & (
  | { opens: SidebarNavTarget; onClick?: never }
  | { onClick: () => void; opens?: never }
);

/**
 * A custom sidebar region — a whole section the shell cannot describe as one
 * nav row (a tree, a search box, a split launch control). `title`/`icon` still
 * label it in the layout editor. Build its rows from `SidebarMenu`, which
 * applies the sidebar's rail inset itself, so they align with nav entries.
 */
export type AppShellSidebarComponent = {
  title: string;
  icon: IconRef;
  component: React.ComponentType;
  onClick?: never;
  opens?: never;
  badge?: never;
};

/**
 * A single sidebar contribution: a nav entry (data, drawn by the shell) xor a
 * custom region (a component). An entry that merely needs a badge is still a
 * nav entry — it does not get to redraw the row.
 */
export type AppShellSidebarItem = AppShellSidebarNav | AppShellSidebarComponent;

/**
 * An action item — a ghost button. Requires an `onClick` *and* at least one of
 * `label`/`icon`, so an action is never an invisible empty button. `component`
 * is forbidden: an item is an action xor a custom widget, never both.
 */
export type AppShellToolbarAction = {
  onClick: () => void;
  component?: never;
  group?: string;
} & ({ label: string; icon?: IconRef } | { icon: IconRef; label?: string });

/**
 * A custom-rendered widget. Requires a `component`; the action fields are
 * forbidden so it can't masquerade as a half-specified button.
 */
export type AppShellToolbarComponent = {
  component: React.ComponentType;
  onClick?: never;
  label?: never;
  icon?: never;
  group?: string;
};

/**
 * A single toolbar contribution. The union carries **exactly one** renderable
 * form — an `onClick` action (with a visible label and/or icon) or a
 * `component`. A label-only item with no `onClick`/`component` matches neither
 * member and is unconstructable, so the silent "renders nothing" footgun is
 * impossible by type. {@link ToolbarItem} additionally throws on a forced
 * malformed item rather than rendering null.
 */
export type AppShellToolbarItem =
  AppShellToolbarAction | AppShellToolbarComponent;

function ToolbarItem(item: AppShellToolbarItem) {
  if (item.component) {
    const Comp = item.component;
    return <Comp />;
  }
  if (item.onClick) {
    return (
      <Button variant="ghost" onClick={item.onClick}>
        {item.icon && <Icon icon={item.icon} className="size-4" />}
        {item.label}
      </Button>
    );
  }
  // Unreachable by construction — the AppShellToolbarItem union admits no item
  // with neither `component` nor `onClick`. Fail loudly if one is forced in via
  // an untyped / `as any` contribution, instead of silently rendering nothing.
  throw new Error(
    "AppShellToolbarItem has neither `component` nor `onClick`: a toolbar " +
      "contribution must carry exactly one renderable form (an `onClick` " +
      "action with a label and/or icon, or a `component`).",
  );
}

/**
 * Whether a (possibly absent) render slot has at least one contribution.
 *
 * Reads the registry directly (the same per-slot list `.Render` paints from)
 * rather than the slot's own `useContributions()` hook, so it can be called
 * unconditionally: `slot` may be `undefined`, and a hook can't be called
 * conditionally. This is what lets the chrome toolbar bar be driven by
 * *real* contributions instead of merely whether a slot object was passed —
 * an app that wires a toolbar slot with zero contributors gets no empty bar.
 */
function useSlotHasContributions(slot: SlotHandle | undefined): boolean {
  return useRawContributions(slot).length > 0;
}

/**
 * The current (and default) sidebar framing, extracted verbatim from the
 * sidebar-bearing branch below. Used when no `AppShell.Framing` is contributed,
 * so the shell renders identically even if the sidebar-framing plugin is not
 * loaded. The `flush` variant of sidebar-framing mirrors this byte-for-byte.
 */
function DefaultFlushFraming({
  header,
  sidebarContent,
  body,
}: SidebarFramingProps) {
  return (
    <SidebarProvider className="h-full min-h-0">
      <Sidebar>
        {header && (
          // eslint-disable-next-line layout/no-adhoc-layout -- justify-center vertically centers the header inside shadcn SidebarHeader's own flex column; not a primitive boundary
          <SidebarHeader className="h-sidebar-brand justify-center whitespace-nowrap p-sidebar-brand">
            {header}
          </SidebarHeader>
        )}
        {/* eslint-disable-next-line layout/no-adhoc-layout -- flexible leaf of shadcn Sidebar's not-yet-drained flex column (claims the height left below the header) */}
        <Stack gap="none" className="min-h-0 flex-1">
          {sidebarContent}
        </Stack>
      </Sidebar>

      <SidebarInset className={yieldClass("x")}>{body}</SidebarInset>
    </SidebarProvider>
  );
}

export function AppShellLayout({
  sidebarSlot,
  toolbarSlot,
  sidebarToggleIcons,
  children,
}: {
  /**
   * The left sidebar's item slot. **Optional** — omit for an app with no
   * sidebar; the sidebar (and its trigger in the toolbar) is then not rendered.
   */
  sidebarSlot?: RenderSlot<AppShellSidebarItem>;
  /**
   * The top toolbar's item slot. **Optional** — omit for an app with no
   * toolbar. The chrome toolbar bar renders only when this slot has at least
   * one contribution, so wiring an as-yet-unused slot (a future extension
   * point) costs nothing: no empty bar, and the content's pane header keeps
   * the surface-edge chrome (sidebar toggle) until something contributes.
   */
  toolbarSlot?: RenderSlot<AppShellToolbarItem>;
  /**
   * The sidebar toggle's glyphs, one per state. Omitted, the toggle keeps the
   * default pair (`left-panel-close` while open / `left-panel-open` while closed).
   */
  sidebarToggleIcons?: SidebarToggleIcons;
  /**
   * The main-area content — the app's chosen layout renderer
   * (e.g. `<MillerColumns/>`, `<FullPane/>`, or `<PaneLayoutHost/>`). Chrome
   * (sidebar + toolbar) and renderer are orthogonal and each opt-in: an app
   * supplies only the chrome regions it wants plus its renderer. With neither
   * slot, the shell collapses to a transparent full-surface host.
   */
  children: ReactNode;
}) {
  // Drive the chrome toolbar bar off real contributions, not merely whether a
  // slot object was passed. An app may wire a toolbar slot purely as a future
  // extension point; with zero contributors it must render no bar (otherwise an
  // empty chrome strip strands the sidebar toggle above the content's own pane
  // header). The slot stays a no-op until something contributes to it.
  const hasToolbar = useSlotHasContributions(toolbarSlot);
  // The brand is contributed (AppShell.Brand), never passed: every app draws
  // the same one. With a sidebar it heads the sidebar; without one, its icon
  // form takes the leading edge of the top chrome — the spot the sidebar toggle
  // would otherwise hold. No contribution → nothing, and no empty header.
  const hasBrand = useHasAppShellBrand();
  // Publish whether this surface draws a sidebar (see `useSidebarDrawnOn`):
  // chrome outside the surface — a desktop window's titlebar — styles itself
  // after it.
  const surfaceId = useSurfaceTabId();
  useRecordSidebarDrawn(sidebarSlot ? surfaceId : undefined);

  const toolbar = hasToolbar && toolbarSlot && (
    <Bar tier="chrome">
      {sidebarSlot ? (
        <SidebarTrigger icons={sidebarToggleIcons} />
      ) : (
        hasBrand && <AppShellBrand form="icon" />
      )}
      <toolbarSlot.Render>
        {(item) => <ToolbarItem {...item} />}
      </toolbarSlot.Render>
    </Bar>
  );

  // Hand the content region's top-most pane header the surface-edge chrome.
  // When there's no `chrome`-tier toolbar above it, the columns own the surface
  // top: the first column header hosts the sidebar toggle (with no sidebar, the
  // brand's icon form) and the last reserves the floating-action-bar safe area.
  // With a toolbar, the toolbar owns both.
  const surfaceChrome = useMemo(
    () => ({
      contentOwnsTopChrome: !hasToolbar,
      leadingControl: sidebarSlot ? (
        <SidebarTrigger icons={sidebarToggleIcons} />
      ) : hasBrand ? (
        <AppShellBrand form="icon" />
      ) : undefined,
    }),
    [hasToolbar, sidebarSlot, sidebarToggleIcons, hasBrand],
  );
  const body = (
    <>
      {toolbar}
      {/* The content canvas inherits the framing surface (`--background`) rather
          than painting its own tint. Sticky chrome inside the canvas (the
          DataView toolbar, pane/section headers) masks scrolled content with
          `bg-chrome-mask`, which follows `--chrome-mask` (the page canvas by
          default). So a tinted canvas is no longer a footgun — it would just
          need to co-publish `--chrome-mask` alongside its background, exactly as
          the sidebar and `<Surface>` roles do — but we keep it on `--background`
          as the plain default. */}
      <Clip as="main" fill>
        <SurfaceChromeContext.Provider value={surfaceChrome}>
          {children}
        </SurfaceChromeContext.Provider>
      </Clip>
    </>
  );

  // A UI plugin can contribute the sidebar/main framing (flush/floating/inset).
  // Exactly one framing is expected — its Region internally dispatches to the
  // per-app active variant. With none, fall back to the inline default flush.
  const framings = AppShell.Framing.useContributions();

  // No sidebar → no SidebarProvider/Inset; just a full-height column holding
  // the (optional) toolbar and the main renderer. Framing is sidebar-only.
  if (!sidebarSlot) {
    return (
      <Stack gap="none" className="h-full min-h-0">
        {body}
      </Stack>
    );
  }

  const sidebarContent = (
    // Publish the sidebar surface color (`--sidebar`) as the sticky-chrome mask
    // for the whole sidebar subtree, so a sticky header inside it (e.g. a
    // DataView toolbar) masks with the sidebar tone instead of the page canvas.
    // One place covers every framing (flush/floating/inset), which all render
    // the shadcn `bg-sidebar` surface. `display:contents` keeps this wrapper out
    // of the sidebar's flex layout — it only carries the inherited var.
    // It likewise publishes `--sidebar-accent` as `--hover-fill`, the tone a
    // transient hover paints on this surface. `SidebarMenuButton` already
    // hovers to `--sidebar-accent`; a ghost `Button`/`IconButton` hovers to
    // `bg-hover-fill`, which now resolves to the SAME tone — so the two halves
    // of a mixed row (e.g. the launch row's model dropdown + its play button)
    // highlight identically by construction instead of one silently landing on
    // the page-canvas `--muted`, which sits on top of `--sidebar` and reads as
    // no hover at all.
    // `rail-owe-sidebar` sets the sidebar's rail to its own sidebar-metrics
    // `sidebarRail` (default `--space-sm`) instead of
    // the `rail-follow` fallback (the pane-header `--chrome-pad-x`), so any
    // DataView rendered in a sidebar sits on the sidebar's pill rail: band
    // chrome (toolbar, section headers) at the rail, row pills inset by it —
    // and every `SidebarMenu` pays the same debt via its own `rail-follow`, so
    // nav rows and DataView rows land on one rail with nobody writing `px-sm`. `--pad-row-x` ≡ `--space-sm` at
    // every density, so row content lands on the same rail as nav icon/label.
    //
    // `owe`, not `rail-sm`: it declares the rail WITHOUT paying it, so the
    // sidebar's own bands apply the inset and their hover fills and section
    // rules still reach the sidebar's edge. `rail-sm` would pad here too, and
    // every band would then inset twice.
    <div
      className="rail-owe-sidebar"
      style={
        {
          display: "contents",
          "--chrome-mask": "var(--sidebar)",
          "--hover-fill": "var(--sidebar-accent)",
        } as React.CSSProperties
      }
    >
      <sidebarSlot.Render>
        {(item) => <SidebarItem {...item} />}
      </sidebarSlot.Render>
      {/* The sidebar's bottom inset under its last item — sidebar-metrics
          `sidebarEndPad`, default 0 (nothing). A box rather than padding: this
          wrapper is `display: contents` and the framing owns the column. */}
      <div aria-hidden className={`${rigidClass()} h-sidebar-end`} />
    </div>
  );

  // useContributions() seals the `component` field, so the framing can't be
  // rendered as <Framing/>; route it through renderIsolated (which unseals and
  // applies the error-boundary middleware). No contribution → inline default.
  const framingProps: SidebarFramingProps = {
    header: hasBrand ? <AppShellBrand form="header" /> : undefined,
    sidebarContent,
    body,
  };
  const framing = framings[0];
  return framing ? (
    renderIsolated(
      AppShell.Framing,
      framing as unknown as Contribution,
      framingProps,
    )
  ) : (
    <DefaultFlushFraming {...framingProps} />
  );
}
