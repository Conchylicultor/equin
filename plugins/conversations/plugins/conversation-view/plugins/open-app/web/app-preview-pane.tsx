import {
  Pane,
  PaneChrome,
  PaneIconAction,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import {
  asNamespace,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";
import { withEmbedFlag } from "@plugins/primitives/plugins/embed/core";
import { useDraft } from "@plugins/primitives/plugins/persistent-draft/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { NewTabButton } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";
import { createContext, useCallback, useContext, useState } from "react";

const chromeIcon = symbol("web-asset");
const reloadIcon = symbol("refresh");

/**
 * Reloads THIS pane's frame. Provided by the pane body around its chrome, so a
 * header action reaches the frame of the pane it sits in — not every open
 * preview. Null outside a preview pane, which the action treats as a bug.
 */
const ReloadFrameContext = createContext<(() => void) | null>(null);

/**
 * Whether the framed app shows its own chrome (tab bar, app rail). One
 * browser-wide preference, shared by the header toggle and the frame through
 * the draft key, and kept until changed (no expiry).
 */
function useShowChrome() {
  return useDraft("open-app:show-chrome", false, { ttl: Infinity });
}

/**
 * The agent's own deploy, framed beside its conversation.
 *
 * `path` is the in-app route to open (path, query and hash) as ONE encoded
 * segment rather than a `:path*` wildcard: a wildcard needs at least one part,
 * and the app root `/` has none — so `/` is spelled by leaving `path` out.
 */
export const appPreviewPane = Pane.define({
  route: defineRoute({ id: "app-preview", segment: "app/:attemptId/:path?" }),
  app: agentManagerApp,
  component: AppPreviewPaneBody,
  title: { useText: ({ attemptId }) => attemptId },
  chrome: { history: false },
  width: 900,
  useResolve: false,
});

/**
 * The route's full URL on the agent's namespace. An attempt id IS its worktree
 * checkout name, and the main composition's prefix elides — so the attempt id
 * is the namespace.
 */
export function appPreviewUrl(attemptId: string, path: string | undefined) {
  return namespaceUrl(asNamespace(attemptId), path ?? "/");
}

function AppPreviewPaneBody() {
  const { attemptId, path } = appPreviewPane.useParams();
  const url = appPreviewUrl(attemptId, path);
  const origin = new URL(url).origin;
  const [showChrome] = useShowChrome();
  // Bumped by the Reload action. The frame is cross-origin, so we cannot call
  // its `location.reload()`; remounting it under a new key is a fresh load of
  // the pane's route.
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);
  // Chromeless by default: the pane already sits in our own chrome, so the
  // framed app shows just the screen. The embed mode is read once at the
  // framed app's boot, so switching it is a new document (see `key`).
  const src =
    origin +
    withEmbedFlag(path ?? "/", origin, showChrome ? "chrome" : "chromeless");
  return (
    <ReloadFrameContext.Provider value={reload}>
      <PaneChrome pane={appPreviewPane}>
        <iframe
          // A new route is a new document: remount rather than let the old
          // frame's in-app navigation outlive the URL that named it.
          key={`${src}#${reloads}`}
          src={src}
          title={`App preview — ${attemptId}`}
          className="h-full w-full border-0"
        />
      </PaneChrome>
    </ReloadFrameContext.Provider>
  );
}

/** Header action: load the framed app afresh (after a rebuild, or a bad state). */
export function ReloadAction() {
  const reload = useContext(ReloadFrameContext);
  if (!reload)
    throw new Error("ReloadAction rendered outside an app-preview pane");
  return <PaneIconAction label="Reload" icon={reloadIcon} onClick={reload} />;
}

/** Header action: the same route, unframed, in a new browser tab. */
export function OpenInNewTabAction() {
  const { attemptId, path } = appPreviewPane.useParams();
  return (
    <NewTabButton
      href={appPreviewUrl(attemptId, path)}
      label="Open in a new tab"
    />
  );
}

/** Header action: show or hide the framed app's own tab bar and app rail. */
export function ToggleChromeAction() {
  const [showChrome, setShowChrome] = useShowChrome();
  return (
    <PaneIconAction
      label={showChrome ? "Hide app chrome" : "Show app chrome"}
      icon={chromeIcon}
      aria-pressed={showChrome}
      onClick={() => setShowChrome((v) => !v)}
    />
  );
}
