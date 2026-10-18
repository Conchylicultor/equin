import { defineInstallSink } from "@plugins/primitives/plugins/scope/plugins/install-sink/web";
import type { WindowId } from "../hooks/use-floating-windows";

/**
 * Where a window minimises TO: the shelf entry that represents it. The shelf
 * (another plugin) installs the resolver; the window motion asks it for the
 * viewport rect to aim the minimise / restore tween at, and falls back to
 * "straight down" when no resolver is installed or the entry is not on screen.
 */
type MinimizeTargetResolver = (windowId: WindowId) => DOMRect | null;

const minimizeTargetSink = defineInstallSink<MinimizeTargetResolver>({
  name: "desktop.minimize-target",
  what: "the shelf's minimise-target resolver (installed by apps/desktop/shelf)",
});

/** Install the resolver; returns the disposer that uninstalls it. */
export function setMinimizeTargetResolver(
  next: MinimizeTargetResolver,
): () => void {
  return minimizeTargetSink.install(next);
}

/**
 * The viewport rect `windowId` minimises to, or null when there is none. An
 * imperative read for the motion's tween start (an event, never a render).
 */
export function peekMinimizeTarget(windowId: WindowId): DOMRect | null {
  return minimizeTargetSink.peek()?.(windowId) ?? null;
}
