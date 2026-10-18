import { defineInstallSink } from "@plugins/primitives/plugins/scope/plugins/install-sink/web";

/** What the mounted launcher overlay lets the rest of the desktop do to it. */
interface LauncherControls {
  open(): void;
  close(): void;
  toggle(): void;
}

/**
 * The launcher's visibility is the overlay's own React state; the shortcut and
 * the shelf's launcher button reach it through this sink, which the overlay
 * fills while it is mounted (exactly while the desktop is active). Calling a
 * control with no desktop up is a bug, so the sink throws rather than no-ops.
 */
export const launcherControlsSink = defineInstallSink<LauncherControls>({
  name: "desktop.launcher",
  what: "the launcher's open / close controls (installed by the launcher overlay while the desktop is active)",
});

export function openLauncher(): void {
  launcherControlsSink.peekOrThrow().open();
}

export function closeLauncher(): void {
  launcherControlsSink.peekOrThrow().close();
}

export function toggleLauncher(): void {
  launcherControlsSink.peekOrThrow().toggle();
}
