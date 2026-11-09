import { useLive } from "@plugins/network/plugins/live/web";
import type { ResourceError } from "@plugins/network/plugins/live/plugins/live-state/web";
import { fileSystemsServed, type FileSystemKind } from "../../core";

/** Which file systems this host serves (`files.systems`), once it has said. */
export type FileSystemsState =
  | { kind: "pending" }
  | { kind: "failed"; error: ResourceError; refetch: () => Promise<void> }
  | { kind: "ready"; served: readonly FileSystemKind[] };

/**
 * The file systems this host serves — a system it does not is absent: a
 * browser lists no place of it and opens none of its folders.
 */
export function useFileSystems(): FileSystemsState {
  const served = useLive(fileSystemsServed);
  switch (served.status) {
    case "loading":
      return { kind: "pending" };
    case "error":
      return { kind: "failed", error: served.error, refetch: served.refetch };
    case "ready":
      return { kind: "ready", served: served.data };
  }
}
