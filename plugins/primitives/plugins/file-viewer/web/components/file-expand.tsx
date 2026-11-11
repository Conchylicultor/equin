import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { gestureOf } from "@plugins/primitives/plugins/link-gesture/web";
import { useMorphFromElement } from "@plugins/primitives/plugins/pane/web";
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
 * ({@link FileExpandButton}). `resolve` runs in the renderer's tree, so it
 * reads the renderer's state (the player's playhead).
 */
export function FileExpandAction({
  label,
  resolve,
}: FileRendererExpand): ReactNode {
  const setExpand = useContext(FileExpandContext);
  // The latest handler, so the declaration below holds across renders: a
  // fresh declaration each render would re-render the host each render.
  const latest = useRef(resolve);
  useLayoutEffect(() => {
    latest.current = resolve;
  });
  useLayoutEffect(() => {
    if (setExpand === null) return;
    const mine: FileRendererExpand = {
      label,
      resolve: () => latest.current(),
    };
    setExpand(mine);
    return () => setExpand((prev) => (prev === mine ? null : prev));
  }, [label, setExpand]);
  return null;
}

/**
 * The host's half, for a host with no pane Expand to hand it to: the active
 * renderer's Expand as a header button, nothing while it declares none. The
 * app it opens grows out of the button.
 */
export function FileExpandButton({
  renderers,
}: {
  renderers: FileRenderersHandle;
}): ReactNode {
  const { expand } = renderers;
  const { attach, morph } = useMorphFromElement();
  if (expand === null) return null;
  return (
    <IconButton
      ref={attach}
      icon={navIcons.expand}
      label={expand.label}
      onClick={async (e) => {
        const gesture = gestureOf(e);
        morph(await expand.resolve()).open(gesture);
      }}
    />
  );
}
