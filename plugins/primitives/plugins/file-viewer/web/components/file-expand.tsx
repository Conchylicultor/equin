import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { navIcons } from "@plugins/ui/plugins/icons/core";
import type {
  FileRendererExpand,
  FileRenderersHandle,
} from "./use-file-renderers";

/**
 * Where the active renderer's Expand is declared to: the renderers handle's
 * `setExpand`, handed to the renderer by `FileContent`.
 */
export const FileExpandContext = createContext<
  FileRenderersHandle["setExpand"] | null
>(null);

/**
 * The renderer's half: its file's fuller view elsewhere (the MIDI preview's
 * Open in Sonata), declared to its host. Renders nothing — the host draws it
 * once, where its Expand belongs: as its pane's Expand (`PaneChrome`'s
 * `expand`, given the handle's `expand`) or in its own header
 * ({@link FileExpandButton}). `onActivate` runs in the renderer's tree, so it
 * reads the renderer's state (the player's playhead).
 */
export function FileExpandAction({
  label,
  onActivate,
}: FileRendererExpand): ReactNode {
  const setExpand = useContext(FileExpandContext);
  // The latest handler, so the declaration below holds across renders: a
  // fresh declaration each render would re-render the host each render.
  const latest = useRef(onActivate);
  useLayoutEffect(() => {
    latest.current = onActivate;
  });
  useLayoutEffect(() => {
    if (setExpand === null) return;
    const mine: FileRendererExpand = {
      label,
      onActivate: () => latest.current(),
    };
    setExpand(mine);
    return () => setExpand((prev) => (prev === mine ? null : prev));
  }, [label, setExpand]);
  return null;
}

/**
 * The host's half, for a host with no pane Expand to hand it to: the active
 * renderer's Expand as a header button, nothing while it declares none.
 */
export function FileExpandButton({
  renderers,
}: {
  renderers: FileRenderersHandle;
}): ReactNode {
  const { expand } = renderers;
  if (expand === null) return null;
  return (
    <IconButton
      icon={navIcons.expand}
      label={expand.label}
      onClick={() => expand.onActivate()}
    />
  );
}
