import {
  defineDesktopSink,
  type DesktopRuntime,
} from "@plugins/apps/plugins/desktop/plugins/windows/web";

interface SwitcherControls {
  /** Open on the first press, then step the selection (+1 forward, −1 back). */
  step(delta: number): void;
}

/** Each desktop's switcher step control (installed by its switcher overlay). */
export const switcherControls = defineDesktopSink<SwitcherControls>({
  name: "desktop.switcher",
  what: "the window switcher's step control (installed by the switcher overlay while the desktop is active)",
});

/** Step `desk`'s switcher (open it on the first press). */
export function stepSwitcher(desk: DesktopRuntime, delta: number): void {
  switcherControls.peekOrThrow(desk).step(delta);
}
