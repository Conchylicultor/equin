import { useContext, useMemo } from "react";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import {
  PaneInstanceContext,
  PaneMatchContext,
  openedHereEntry,
  useOpenPane,
  useStoreResolver,
  type AnyPane,
  type PaneObject,
} from "./pane";

/**
 * A pane and its params, as DATA — what an opener names when all it may do is
 * open a column beside the surface holding it (an id chip), never navigate to
 * a whole app or start a fresh route. Built only by {@link paneTarget}, which
 * checks the params against the pane; opened by {@link usePaneToggle}.
 */
export interface PaneTarget {
  readonly pane: AnyPane;
  readonly params: Readonly<Record<string, string>>;
}

/** Name `pane` with `params` (type-checked against the pane's own params). */
export function paneTarget<Params>(
  pane: PaneObject<Params, any, any, any>,
  params: NoInfer<Params>,
): PaneTarget {
  return { pane, params: params as Record<string, string> };
}

/**
 * The toggle for pane targets, bound to the caller's place: for each target,
 * the link that opens it as a column beside the surface holding the caller
 * (`push`) — or closes it, when this surface already has that exact pane and
 * params open. Its `href` is always the opened route's URL: a ⌘/middle-click
 * opens it in a new browser tab, never closes.
 *
 * Legal outside every surface (global chrome), like `useOpenPane`: there it
 * has opened nothing, so it always opens.
 */
export function usePaneToggle(): (target: PaneTarget) => LinkTarget {
  const openPane = useOpenPane();
  // The store is resolved per click, like `useOpenPane`'s: the surface's own
  // (an embed's included), else the focused tab's.
  const resolveStore = useStoreResolver();
  const match = useContext(PaneMatchContext);
  const selfInstanceId = useContext(PaneInstanceContext);
  return useMemo(
    () => (target) => {
      const opened = openedHereEntry(
        match,
        selfInstanceId,
        target.pane._internal,
      );
      const push = openPane.to(target.pane, target.params, { mode: "push" });
      return {
        open: () => {
          if (opened && sameParams(opened.params, target.params)) {
            resolveStore().close(target.pane._internal, opened.instanceId);
          } else {
            push.open();
          }
        },
        href: push.href,
      };
    },
    [openPane, resolveStore, match, selfInstanceId],
  );
}

function sameParams(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const defined = (r: Readonly<Record<string, string>>) =>
    Object.entries(r).filter(([, v]) => v !== undefined);
  const ea = defined(a);
  const eb = defined(b);
  return ea.length === eb.length && ea.every(([k, v]) => b[k] === v);
}
