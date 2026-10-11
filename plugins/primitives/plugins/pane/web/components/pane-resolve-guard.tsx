import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import { Bar } from "@plugins/primitives/plugins/bar/web";
import { useState, type ComponentType, type ReactNode } from "react";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { segmentRequiredParamNames } from "../../core";
import { paneObjectFor, type PaneInternal, type ResolveHook } from "../pane";
import { PaneIconAction } from "./pane-icon-action";
import { navIcons, symbol } from "@plugins/ui/plugins/icons/core";

const closeIcon = symbol("close");

interface Props {
  pane: PaneInternal;
  params: Record<string, string>;
}

export function PaneResolveGuard({ pane, params }: Props) {
  if (!pane.useResolve) {
    const Component = pane.component;
    return <Component />;
  }
  // Key the sticky guard on the resolved identity: the pane and the params that
  // ADDRESS its entity (the required ones). A `swap` re-roots a pane in place —
  // new params, SAME mounted guard — so without the key the sticky-found memory
  // would leak from one resource to the next. The key gives React a fresh guard
  // instance (fresh `sawFound`) per identity, making that leak structurally
  // impossible; a transient `pending`/`error` flip keeps the identity stable, so
  // the instance — and its stickiness — survives. An optional `:param?` or a
  // keyed `;name` is a VIEW of the entity (`useSetParams` rewrites it in place),
  // so it is not part of the key: changing it must not remount the pane.
  return (
    <StickyResolveGuard
      key={resolveIdentity(pane, params)}
      pane={pane}
      useResolve={pane.useResolve}
      component={pane.component}
      params={params}
    />
  );
}

/** Stable per-(pane, addressing params) key so identity changes remount the guard. */
function resolveIdentity(
  pane: PaneInternal,
  params: Record<string, string>,
): string {
  const parts = segmentRequiredParamNames(pane.segment)
    .sort()
    .map((k) => `${k}=${params[k]}`);
  return `${pane.id}\u0000${parts.join("\u0000")}`;
}

/**
 * Sticky-found resolve gate. Once the entity has resolved (`found`) for this
 * identity, the real pane stays mounted through any later `pending` or `error`
 * flip — e.g. an HTTP-fallback refetch failing under host memory pressure.
 * Swapping in a fallback there would unmount the pane and destroy the user's
 * scroll, focus, and unsaved editor draft (the debounce timer is cleared on
 * unmount without flushing), then remount cold on recovery. The mounted body
 * reads its own data and renders that failure where it lands.
 *
 * Before the first `found`, each state gets its own chrome: `pending` a
 * spinner, `error` the failure with its Retry (ResourceErrorInline), and a
 * determinate miss Not Found. The gate downgrades a found pane only on a
 * SETTLED miss (`missing`): a resource genuinely deleted while its
 * pane is open still surfaces Not Found — stickiness masks transient failures,
 * never real deletion.
 */
function StickyResolveGuard({
  pane,
  useResolve,
  component: Component,
  params,
}: {
  pane: PaneInternal;
  /**
   * Hook-named so the React Compiler treats the call as a hook: a plain
   * `resolve(params)` gets memoized on (resolve, params), and the render-phase
   * `setSawFound` re-pass then skips the resolve hook's hooks — the next
   * `useState` lands on a slot without a queue (React #311).
   */
  useResolve: ResolveHook<Record<string, string>>;
  component: ComponentType;
  params: Record<string, string>;
}) {
  const result = useResolve(params);
  const found = result.status === "found";

  // `sawFound` latches true the first time this identity resolves. Adjusting
  // state during render (guarded by `!sawFound`) is React's sanctioned pattern
  // for deriving state from props without an effect — no flash, no extra frame.
  const [sawFound, setSawFound] = useState(false);
  if (found && !sawFound) setSawFound(true);

  if (found || (sawFound && result.status !== "missing")) return <Component />;

  switch (result.status) {
    case "pending":
      return (
        <FallbackChrome pane={pane} title="Loading…">
          <Loading />
        </FallbackChrome>
      );
    case "error": {
      const { retry } = result;
      return (
        <FallbackChrome pane={pane} title="Couldn't load">
          <ResourceErrorInline
            variant="block"
            error={result.error}
            refetch={
              retry === undefined ? undefined : () => retry().then(() => {})
            }
          />
        </FallbackChrome>
      );
    }
    case "missing":
      return (
        <FallbackChrome pane={pane} title="Not Found">
          <Placeholder tone="error">
            This resource couldn't be found.
          </Placeholder>
        </FallbackChrome>
      );
  }
}

/**
 * Minimal chrome header for resolve-guard fallback states (Loading /
 * Couldn't load / Not Found). The resolved resource is absent, so the real pane component — and
 * its `Actions` contributions — never render. We still want the standard
 * navigation controls (promote and especially × close) so the pane can be
 * dismissed. Mirrors `PaneChrome`'s control logic and gating but omits the
 * actions slot, which has no resource to act on.
 */
function FallbackChrome({
  pane,
  title,
  children,
}: {
  pane: PaneInternal;
  title: string;
  children: ReactNode;
}) {
  const paneObject = paneObjectFor(pane);
  const chrome = pane.chrome;
  const doClose = paneObject.useClose();
  const promote = paneObject.usePromote();
  return (
    <Column
      className="h-full"
      header={
        <Bar tier="pane">
          <Text as="span" variant="label" tone="muted" className="truncate">
            {title}
          </Text>
          <Stack direction="row" align="center" gap="sm" className="ml-auto">
            {chrome.promote && promote && (
              <PaneIconAction
                label={
                  promote.kind === "cross-app"
                    ? `Open in ${promote.app.name}`
                    : "Expand pane"
                }
                icon={navIcons.expand}
                {...linkProps(promote)}
              />
            )}
            {chrome.close && doClose && (
              <PaneIconAction
                label="Close"
                icon={closeIcon}
                onClick={doClose}
              />
            )}
          </Stack>
        </Bar>
      }
      scrollBody={false}
      body={<Center className="h-full">{children}</Center>}
    />
  );
}
