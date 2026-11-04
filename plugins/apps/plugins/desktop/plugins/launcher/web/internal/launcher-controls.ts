import {
  defineDesktopSink,
  type DesktopRuntime,
} from "@plugins/apps/plugins/desktop/plugins/windows/web";

interface LauncherControls {
  open(): void;
  close(): void;
  toggle(): void;
}

/** Each desktop's launcher controls (installed by its launcher overlay). */
export const launcherControls = defineDesktopSink<LauncherControls>({
  name: "desktop.launcher",
  what: "the launcher's open / close controls (installed by the launcher overlay while the desktop is active)",
});

/** Open `desk`'s launcher. */
export function openLauncher(desk: DesktopRuntime): void {
  launcherControls.peekOrThrow(desk).open();
}

/** Close `desk`'s launcher. */
export function closeLauncher(desk: DesktopRuntime): void {
  launcherControls.peekOrThrow(desk).close();
}

/** Open or close `desk`'s launcher. */
export function toggleLauncher(desk: DesktopRuntime): void {
  launcherControls.peekOrThrow(desk).toggle();
}
