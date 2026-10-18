import { defineInstallSink } from "@plugins/primitives/plugins/scope/plugins/install-sink/web";

/** What the mounted switcher overlay lets the keyboard shortcuts do to it. */
interface SwitcherControls {
  /** Open on the first press, then step the selection (+1 forward, −1 back). */
  step(delta: number): void;
}

/**
 * The switcher's session (open, which window is selected) is the overlay's own
 * React state; the shortcuts reach it through this sink, which the overlay fills
 * while it is mounted (exactly while the desktop is active).
 */
export const switcherControlsSink = defineInstallSink<SwitcherControls>({
  name: "desktop.switcher",
  what: "the window switcher's step control (installed by the switcher overlay while the desktop is active)",
});

export function stepSwitcher(delta: number): void {
  switcherControlsSink.peekOrThrow().step(delta);
}
