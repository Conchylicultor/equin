import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import type { FileLocation } from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import type { FileViewerGit } from "../../core";
import { FileViewer, resolveRenderers, type ResolvedRenderer } from "../slots";
import { useStableLocation } from "../internal/use-stable-location";

/**
 * A renderer's Expand — its file's fuller view elsewhere (Open in Sonata) —
 * declared with `FileExpandAction`, drawn by the host.
 */
export interface FileRendererExpand {
  label: string;
  /**
   * Runs on click and answers where to go, which the host opens as a morph
   * out of its pane (or its button); the button holds pending meanwhile. A
   * failure is the renderer's to report (and rethrow).
   */
  resolve: () => Promise<LinkTarget>;
}

export interface FileRenderersHandle {
  resolved: ResolvedRenderer[];
  active: ResolvedRenderer | null;
  activeId: string | null;
  setActiveId: (id: string) => void;
  /**
   * The Expand the active renderer declared (`FileExpandAction`), for the host
   * to draw once: its pane's Expand, or `FileExpandButton` in its header.
   */
  expand: FileRendererExpand | null;
  /** Where `FileExpandAction` declares it, handed over by `FileContent`. */
  setExpand: Dispatch<SetStateAction<FileRendererExpand | null>>;
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
  const [expand, setExpand] = useState<FileRendererExpand | null>(null);
  // Stable identity: a host's header reads this through a context value.
  return useMemo(
    () => ({ resolved, active, activeId, setActiveId, expand, setExpand }),
    [resolved, active, activeId, expand],
  );
}
