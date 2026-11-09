import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { FileRenderersHandle } from "./use-file-renderers";

/**
 * Where a renderer's header actions land: the element the host's
 * {@link FileHeaderActions} placed in its header, handed to the renderer by
 * `FileContent`. `null` until that element mounts.
 */
export const FileHeaderActionsContext = createContext<HTMLElement | null>(null);

/**
 * The host's half: where in its header the active renderer's actions go (the
 * MIDI preview's Open in Sonata, as the header's standard Expand). Placed by
 * every host that draws a header over `FileContent`, beside its `FileTabs`;
 * takes no room of its own (`display: contents`), so an action is laid out as
 * one of the header's own items.
 */
export function FileHeaderActions({
  attach,
}: {
  /** The renderers handle's `header.attach`. */
  attach: FileRenderersHandle["header"]["attach"];
}): ReactNode {
  return <span ref={attach} className="contents" />;
}

/**
 * The renderer's half: `children` drawn in the host's header, while staying in
 * the renderer's React tree — so an action reads the renderer's own state (the
 * MIDI preview's player, for the bar it is at). Nothing until the host's
 * element has mounted.
 */
export function FileHeaderAction({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  const host = useContext(FileHeaderActionsContext);
  return host ? createPortal(children, host) : null;
}
