import type { CSSProperties, ReactNode } from "react";
import type { HostProgress } from "@plugins/framework/plugins/browser-server/core";
import type { DemoBoot } from "@plugins/framework/plugins/browser-server/plugins/demo/plugins/scope/web";
import {
  Button,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Logo } from "@plugins/ui/plugins/logo/web";
import { LOGO } from "@plugins/ui/plugins/logo/core";
import "./demo-boot-screen.css";

const MB = 1024 * 1024;

/**
 * How much of the boot is done, 0–1, weighed from the worker's facts: the
 * starting data's download (when the boot loads one — the largest part of a
 * first visit), then the plugin modules loaded; the last stretch (the
 * database, the live feed) has no report of its own, so the bar holds short
 * of the end until the demo appears.
 */
function doneFraction(progress: HostProgress | null): number {
  if (progress === null) return 0;
  const dataWeight = progress.data === null ? 0 : 0.6;
  const pluginsWeight = 0.92 - dataWeight;
  const data =
    progress.data === null ? 0 : progress.data.received / progress.data.total;
  const plugins =
    progress.plugins === null
      ? 0
      : progress.plugins.loaded / progress.plugins.total;
  return dataWeight * data + pluginsWeight * plugins;
}

/** Every plugin module has loaded: what is left is starting it. */
const isStarting = (progress: HostProgress | null): boolean =>
  progress?.plugins != null &&
  progress.plugins.loaded === progress.plugins.total;

/**
 * The demo before it runs — what `<DemoScope boot>` draws: the equin logo
 * over the logo's own colours, then
 * - at the gate, the Enter button (nothing has downloaded yet: the first
 *   start downloads the whole server and its data);
 * - while it is not known yet whether the visitor is already in the demo in
 *   another tab (`checking`, a few ms), the logo alone;
 * - while it starts, one bar in the logo's gradient, what it is doing and
 *   how much it downloaded so far, in place of the button.
 *
 * It fills its box: the /demo frame, the website's demo band — or the whole
 * page, where the URL it opens is maximized.
 */
export function DemoBootScreen({ state }: { state: DemoBoot }): ReactNode {
  const colours = {
    "--demo-boot-from": LOGO.gradient.from,
    "--demo-boot-to": LOGO.gradient.to,
  } as CSSProperties;
  return (
    <div className="demo-boot" style={colours} data-demo-boot={state.kind}>
      <div className="demo-boot-body">
        <Logo className="demo-boot-logo" />
        <div className="demo-boot-slot">
          {state.kind === "gate" && (
            <>
              {/* The one call to action on the screen: a size up. */}
              <ControlSizeProvider size="lg">
                <Button className="demo-boot-enter" onClick={state.enter}>
                  Enter equin <span aria-hidden>→</span>
                </Button>
              </ControlSizeProvider>
              <Text
                as="p"
                variant="body"
                tone="muted"
                className="demo-boot-sub"
              >
                Try a demo version in this tab
              </Text>
            </>
          )}
          {state.kind === "starting" && <BootBar progress={state.progress} />}
        </div>
      </div>
    </div>
  );
}

function BootBar({ progress }: { progress: HostProgress | null }): ReactNode {
  const fraction = doneFraction(progress);
  const percent = Math.round(fraction * 100);
  const downloaded = progress?.downloadedBytes ?? 0;
  const label = isStarting(progress)
    ? "Starting equin"
    : downloaded > 0
      ? "Downloading equin in your browser"
      : "Starting equin";
  return (
    <div
      className="demo-boot-bar"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <div className="demo-boot-track">
        <div className="demo-boot-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="demo-boot-under">
        <Text variant="caption" tone="muted">
          {label}
        </Text>
        <Text variant="caption" tone="muted">
          {downloaded > 0
            ? `${(downloaded / MB).toFixed(1)} MB`
            : `${percent}%`}
        </Text>
      </div>
    </div>
  );
}
