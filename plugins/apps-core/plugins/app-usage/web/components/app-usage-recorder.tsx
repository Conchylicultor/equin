import { useEffect, useState } from "react";
import { useFocusedAppId } from "@plugins/apps-core/web";
import {
  EndpointError,
  fetchEndpointOver,
} from "@plugins/infra/plugins/endpoints/web";
import { pageTransport } from "@plugins/primitives/plugins/networking/plugins/page-transport/web";
import { flushAppUsageEndpoint } from "../../core";
import { createUsageTracker } from "../internal/usage-tracker";
import { readLastApp, writeLastApp } from "../internal/last-app";

// Page-wide telemetry: app usage always reaches the page's own server (D3).
const fetchEndpoint = fetchEndpointOver(pageTransport);

// Input that proves the user is here. `pointermove` included: reading while
// nudging the mouse is use. Listened to passively, in capture, on the window.
const INPUT_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "touchstart",
] as const;

/**
 * Headless (`Core.Root`): feeds the focused app, page visibility, window focus
 * and input into the usage tracker. Mounted once per page; a second window is
 * its own page, and only the window with OS focus accrues time.
 */
export function AppUsageRecorder(): null {
  const appId = useFocusedAppId();
  const [tracker] = useState(() =>
    createUsageTracker({
      now: () => Date.now(),
      send: (entries) =>
        fetchEndpoint(
          flushAppUsageEndpoint,
          {},
          // keepalive: the pagehide flush must outlive the page. A failed
          // usage post is not a user-facing error.
          { body: { entries }, keepalive: true, report: false },
        ),
      // The server is down or restarting — keep the batch for the retry.
      // Anything else is a bug and surfaces.
      isRetryable: (err) =>
        err instanceof EndpointError || err instanceof TypeError,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      lastApp: readLastApp(),
    }),
  );

  useEffect(() => {
    tracker.setApp(appId);
    if (appId !== undefined) writeLastApp(appId);
  }, [tracker, appId]);

  useEffect(() => {
    const onInput = () => tracker.input();
    const onVisibility = () =>
      tracker.setVisible(document.visibilityState === "visible");
    const onFocus = () => tracker.setWindowFocused(true);
    const onBlur = () => tracker.setWindowFocused(false);
    const onPageHide = () => tracker.pageHide();
    const opts = { capture: true, passive: true };
    for (const e of INPUT_EVENTS) window.addEventListener(e, onInput, opts);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pagehide", onPageHide);
    tracker.setWindowFocused(document.hasFocus());
    onVisibility();
    return () => {
      for (const e of INPUT_EVENTS)
        window.removeEventListener(e, onInput, opts);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pagehide", onPageHide);
      tracker.pageHide();
      tracker.dispose();
    };
  }, [tracker]);

  return null;
}
