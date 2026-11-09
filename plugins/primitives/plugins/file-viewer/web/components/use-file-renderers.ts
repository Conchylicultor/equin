import { useMemo, useState } from "react";
import type { FileLocation } from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import type { FileViewerGit } from "../../core";
import { FileViewer, resolveRenderers, type ResolvedRenderer } from "../slots";
import { useStableLocation } from "../internal/use-stable-location";

export interface FileRenderersHandle {
  resolved: ResolvedRenderer[];
  active: ResolvedRenderer | null;
  activeId: string | null;
  setActiveId: (id: string) => void;
}

/**
 * The renderers offered for one file, best tier first, and which one is
 * showing. The selection is local state; a host that splits the tabs (header)
 * from the content (body) reads both halves off this one handle.
 */
export function useFileRenderers({
  file,
  git,
}: {
  file: FileLocation;
  git?: FileViewerGit;
}): FileRenderersHandle {
  const contributions = FileViewer.Renderer.useContributions();
  const stableFile = useStableLocation(file);
  // Keyed on the fields, so a host building `git` inline each render does not
  // re-resolve the renderers.
  const checkout = git?.checkout;
  const gitPath = git?.path;
  const status = git?.status;
  const resolved = useMemo(
    () =>
      resolveRenderers(contributions, {
        file: stableFile,
        ...(checkout !== undefined &&
        gitPath !== undefined &&
        status !== undefined
          ? { git: { checkout, path: gitPath, status } }
          : {}),
      }),
    [contributions, stableFile, checkout, gitPath, status],
  );
  const defaultId = resolved[0]?.contribution.id ?? null;
  const [activeId, setActiveId] = useState<string | null>(defaultId);
  const active =
    resolved.find((r) => r.contribution.id === activeId) ?? resolved[0] ?? null;
  // Stable identity: a host's header reads this through a context value.
  return useMemo(
    () => ({ resolved, active, activeId, setActiveId }),
    [resolved, active, activeId],
  );
}
