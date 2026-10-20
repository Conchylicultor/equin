import { useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  type ResourceError,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import {
  fileExplorerGitCheckoutValue,
  fileExplorerGitStatus,
  type GitCheckout,
} from "../../shared/resources";
import { indexGitStatus, type GitStatusIndex } from "../../shared/status-index";

/** A folder in a checkout, as `file-explorer.git-checkout` names it. */
export type Checkout = Extract<GitCheckout, { kind: "checkout" }>;

/**
 * The live status of the checkout at `root`, indexed for any path below it.
 * `null` reads nothing (no checkout yet) and stays loading — never clean.
 */
export function useGitStatus(
  root: string | null,
): ResourceResult<GitStatusIndex> {
  const status = useLive(
    fileExplorerGitStatus,
    root === null ? null : { root },
  );
  return useMemo(() => mapResource(status, indexGitStatus), [status]);
}

/** The checkout and its indexed status for the folder `dir`. */
export type GitView =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "failed"; error: ResourceError; refetch: () => Promise<void> }
  | { kind: "ready"; checkout: Checkout; index: GitStatusIndex };

/**
 * What git knows of the absolute folder `dir`: its checkout (the
 * `file-explorer.git-checkout` snapshot, measured as the folder's view mounts
 * — a folder's checkout only changes when a repo is created around it, which
 * nothing signals), then its live status.
 * The view keeps its identity while neither answer changes (it is memoized on
 * the answers, not on the reads' wrappers), so a lens built from it does too.
 */
export function useGitView(dir: string): GitView {
  const checkout = useLive(fileExplorerGitCheckoutValue, { path: dir });
  const checkoutKnown = checkout.status === "ready";
  const found =
    checkoutKnown && checkout.data.kind === "checkout" ? checkout.data : null;
  const status = useGitStatus(found?.root ?? null);
  const checkoutError = checkout.status === "error" ? checkout.error : null;
  const refetchCheckout = checkout.refetch;
  const index = status.status === "ready" ? status.data : null;
  const statusError = status.status === "error" ? status.error : null;
  const refetchStatus = status.refetch;
  return useMemo<GitView>(() => {
    if (checkoutError !== null)
      return { kind: "failed", error: checkoutError, refetch: refetchCheckout };
    if (found !== null && index !== null)
      return { kind: "ready", checkout: found, index };
    if (statusError !== null)
      return { kind: "failed", error: statusError, refetch: refetchStatus };
    if (checkoutKnown && found === null) return { kind: "none" };
    return { kind: "loading" };
  }, [
    checkoutError,
    checkoutKnown,
    found,
    index,
    refetchCheckout,
    refetchStatus,
    statusError,
  ]);
}
