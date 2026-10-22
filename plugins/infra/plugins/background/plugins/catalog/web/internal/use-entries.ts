import { useLive } from "@plugins/network/plugins/live/web";
import type {
  ResourceResult,
  ResourceUnavailable,
} from "@plugins/primitives/plugins/live-state/web";
import {
  backgroundCatalog,
  backgroundCentralCatalog,
  type BackgroundEntry,
} from "../../core";
import { findEntry } from "./find-entry";

/**
 * The two halves of the catalog: this worktree backend's, and the machine-wide
 * central runtime's. Served by different processes, so each loads (and fails)
 * on its own — a caller renders each half's state, never one standing in for
 * the other. The central half is `unavailable` under a transport with no
 * computer behind it (the demo): there is no central runtime there.
 */
export function useCatalogHalves(): {
  worktree: ResourceResult<BackgroundEntry[]>;
  central: ResourceResult<BackgroundEntry[]> | ResourceUnavailable;
} {
  return {
    worktree: useLive(backgroundCatalog),
    central: useLive(backgroundCentralCatalog),
  };
}

/** `findEntry` over both halves of the live catalog. */
export function useEntry(
  kind: string,
  name: string,
): ResourceResult<BackgroundEntry | null> {
  const { worktree, central } = useCatalogHalves();
  return findEntry([worktree, central], kind, name);
}
