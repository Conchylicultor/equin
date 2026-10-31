import {
  claimPending,
  claimed,
  declined,
  type CodeClaim,
} from "@plugins/active-data/web";
import { hostFsPathStat } from "@plugins/infra/plugins/host-fs/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { useFileLinksWorkspace } from "@plugins/primitives/plugins/file-links/web";

/**
 * The semantic gate for `` `~/Downloads/showcase/` ``: stat the path on the
 * host and claim it only when it is a folder, with its resolved absolute path
 * (`~` expanded, no trailing slash) as the value.
 *
 * A relative path is relative to the checkout the content's host declared
 * (`FileLinksWorkspaceProvider`'s `root`); with none, there is nothing it is
 * relative to and it declines. Every refusal and an unavailable machine are
 * SETTLED declines, never pending: pending stops the chain (see `CodeClaim`).
 */
export function useFolderClaim(text: string): CodeClaim<string> {
  const root = useFileLinksWorkspace()?.root;
  const path = absolutePath(text, root);
  const stat = useLive(hostFsPathStat, path === null ? null : { path });
  if (path === null) return declined("a relative path with no checkout");
  switch (stat.status) {
    case "loading":
      return claimPending();
    case "unavailable":
      return declined(stat.message);
    case "error":
      return declined(`path lookup unavailable: ${stat.error.message}`);
    case "ready":
      return stat.data.entry.kind === "dir"
        ? claimed(stat.data.path)
        : declined(`not a folder: ${stat.data.entry.kind}`);
  }
}

function absolutePath(text: string, root: string | undefined): string | null {
  if (text.startsWith("/") || text.startsWith("~/")) return text;
  if (root === undefined) return null;
  return `${root}/${text}`;
}
