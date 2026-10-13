import type { ReactElement } from "react";
import { useDeferredLoadComplete } from "@plugins/framework/plugins/web-sdk/core";
import { Apps, resolveAppForPath } from "@plugins/apps-core/web";
import { parseUrl } from "@plugins/primitives/plugins/pane/web";
import {
  embedUrl,
  isEmbeddedDocument,
} from "@plugins/primitives/plugins/embed/web";
import type { EmbedMode } from "@plugins/primitives/plugins/embed/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import type {
  CounterpartKindProps,
  CounterpartResolution,
} from "@plugins/apps/plugins/prototypes/plugins/compare/web";

/**
 * The `route:` kind: the running app itself, framed at an in-app path.
 *
 * The frame loads THIS deploy's own origin, chromeless (`?embed=1`: no app
 * rail, no tab bar), so what sits beside the mock is the real screen as this
 * branch renders it — real routing, real live data, real chrome inside the
 * surface — and never a second implementation that could drift from it.
 */
export function RouteCounterpart(props: CounterpartKindProps): ReactElement {
  return <AppCounterpartOf {...props} embed="chromeless" />;
}

/**
 * The `app:` kind: the same running app at the same kind of path, framed WITH
 * its chrome (`?embed=chrome`: the app rail, the tab bar, the action bar) — the
 * whole app as a person sees it in their own tab. For a mock of the chrome
 * itself, or of how a theme reads across chrome and surface together.
 */
export function WholeAppCounterpart(props: CounterpartKindProps): ReactElement {
  return <AppCounterpartOf {...props} embed="chrome" />;
}

/** How each embed mode is named over its half of the stage. */
const TITLES: Record<EmbedMode, string> = {
  chromeless: "App screen",
  chrome: "Whole app",
};

function AppCounterpartOf({
  target,
  children,
  embed,
}: CounterpartKindProps & { embed: EmbedMode }): ReactElement {
  const apps = Apps.App.useContributions();
  const deferredComplete = useDeferredLoadComplete();
  return <>{children(resolve(target, apps, deferredComplete, embed))}</>;
}

function resolve(
  target: string,
  apps: ReturnType<typeof Apps.App.useContributions>,
  deferredComplete: boolean,
  embed: EmbedMode,
): CounterpartResolution {
  // Framing stops at depth one. This document being a framed app screen means
  // the path in some prototype led back to a prototype canvas — its own
  // (`route:/prototypes/proto/<id>`) or another one that leads back —
  // and framing again from here would nest app inside app with no floor.
  if (isEmbeddedDocument()) {
    return {
      status: "unresolved",
      title: "Not framing the app again inside a framed app screen.",
      detail:
        "This canvas is itself inside the real-app frame of another prototype canvas, so its path leads back to one. Framing stops at one level so the screens cannot nest without end.",
    };
  }

  if (!target.startsWith("/")) {
    return {
      status: "unresolved",
      title: (
        <>
          <Badge mono>{target}</Badge> is not an in-app path.
        </>
      ),
      detail:
        "An app counterpart is a root-relative path into this app, starting with a slash — the part of the address after the host, e.g. route:/agents or app:/agents.",
    };
  }

  // The path alone decides which pane answers; a query or hash rides along to
  // the frame untouched but is not part of the route.
  const pathname = new URL(target, "http://x").pathname;

  const resolved = resolveAppForPath(pathname, apps);
  if (resolved === undefined) {
    return {
      status: "unresolved",
      title: (
        <>
          No app in this worktree owns <Badge mono>{pathname}</Badge>.
        </>
      ),
      detail:
        "Every app owns a base path (/agents, /pages, …) and its screens live under it. Prototypes are shared by every worktree while apps are per-worktree code, so a prototype can name a path that only exists on another branch.",
    };
  }

  const parsed = parseUrl(resolved.routePath);
  if (parsed.status === "unresolved") {
    // The pane registry fills in as the deferred plugin tier loads, so an
    // unmatched path is not yet a missing one. "No pane at that path" would be
    // a claim that reverses itself a moment later.
    if (!deferredComplete) {
      return { status: "loading", label: "Loading the app's panes…" };
    }
    return {
      status: "unresolved",
      title: (
        <>
          <Badge mono>{resolved.app.app.name}</Badge> owns that prefix, but this
          worktree has no pane at <Badge mono>{pathname}</Badge>.
        </>
      ),
      detail:
        "The path matches no registered pane. Check it against the address bar when that screen is open.",
    };
  }

  return {
    status: "found",
    title: TITLES[embed],
    subtitle: resolved.app.app.name,
    badge: target,
    href: embedUrl(target, embed),
    render: (width, height) => (
      <AppFrame target={target} embed={embed} width={width} height={height} />
    ),
  };
}

/**
 * The real app, in an iframe on this deploy's own origin.
 *
 * No `sandbox` attribute, on purpose. On a same-origin frame `allow-same-origin`
 * makes the sandbox a no-op as a boundary — the frame can reach the parent and
 * lift its own restrictions — while it silently withholds modals, popups,
 * downloads and forms, so a route that opens a picker would break only inside
 * this stage. Storage, BroadcastChannel and Web Locks are origin-keyed, so the
 * live-state cross-tab election treats the frame as one more document either
 * way. Nothing is gained and something is lost.
 *
 * No `?v=` cache-bust either: the counterpart is the live app, not a file on
 * disk, and a prototype edit must not reboot it.
 */
function AppFrame({
  target,
  embed,
  width,
  height,
}: {
  target: string;
  embed: EmbedMode;
  width: number;
  height: number;
}): ReactElement {
  return (
    <iframe
      title={`${TITLES[embed]} at ${target}`}
      src={embedUrl(target, embed)}
      // Inline geometry, not banned className layout utilities: the canvas's
      // logical size — the same box the prototype frames get, which is what
      // makes the two comparable at all.
      style={{ border: "0", display: "block", width, height }}
    />
  );
}
