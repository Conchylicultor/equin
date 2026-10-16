import {
  createContext,
  createElement,
  useContext,
  type ReactNode,
} from "react";
import { defineInstallSink } from "@plugins/primitives/plugins/scope/plugins/install-sink/web";

/**
 * The seam through which a pane reaches ANOTHER app.
 *
 * A pane can name its home app (`Pane.define({ app })`), so promoting one that
 * is being hosted by a different app has to hand an app-rooted URL to whoever
 * owns the tab set. That owner is `apps-core/tabs` — which imports this
 * primitive, so this primitive cannot import it back. Hence a sink, exactly
 * like {@link HistoryAdapter}: tabs installs its `navigate` at provider mount,
 * and the pane layer calls it without knowing tabs exists.
 *
 * Unset by default. A composition that mounts panes with no tab manager (a
 * test surface, a single-app release) simply has no cross-app destination, and
 * Expand falls back to re-rooting inside the current app rather than painting a
 * control that would do nothing.
 */
export interface AppNavigator {
  /** Put an app-rooted URL on screen — in this tab, or a new one. */
  (url: string, opts?: { newTab?: boolean }): void;
}

/**
 * The cross-app navigator slot. Empty (no fallback): "there is nowhere to go"
 * is a real answer, and the one every render path must ask reactively —
 * `appNavSink.useInstalled()`, never a sample.
 *
 * Installation happens in tabs' provider EFFECT, i.e. a commit after the first
 * render. Panes that mounted in that same commit have already asked "is there
 * anywhere to go?" and been told no; a subscription is what re-renders them
 * when the answer arrives, instead of leaving Expand's presence to whether a
 * pane's plugin happened to load before or after the tab provider.
 */
export const appNavSink = defineInstallSink<AppNavigator>({
  name: "pane.app-nav",
  what: "the cross-app navigator (installed by apps-core/tabs at TabsProvider mount)",
});

/**
 * Navigate to an app-rooted URL. Throws when no navigator is installed: every
 * caller checks first, so reaching here is a real bug (a control was painted
 * that had nowhere to go), and a loud failure is caught by the crash collector
 * rather than manifesting as a dead click.
 *
 * Sampled, not subscribed — this runs from a click handler, after installation.
 */
export function navigateApp(url: string, opts?: { newTab?: boolean }): void {
  appNavSink.peekOrThrow()(url, opts);
}

/**
 * A navigation boundary: the subtree reaches other apps through `navigator`
 * instead of the installed one. An in-process app embed mounts one, so a
 * cross-app hop from inside it (a pane's Expand, the app brand, the launcher,
 * an app link read through a hook) is the embed's to decide — it never drives
 * the host's tabs.
 */
export function AppNavBoundary({
  navigator,
  children,
}: {
  navigator: AppNavigator;
  children: ReactNode;
}): ReactNode {
  return createElement(
    AppNavBoundaryContext.Provider,
    { value: navigator },
    children,
  );
}

const AppNavBoundaryContext = createContext<AppNavigator | null>(null);

/**
 * The navigator this subtree reaches another app through: the nearest
 * {@link AppNavBoundary}'s, else the installed one, else `null` (nowhere to
 * go). Subscribed, like `appNavSink.useInstalled()`: a late install
 * re-renders the caller.
 */
export function useAppNavigator(): AppNavigator | null {
  const bound = useContext(AppNavBoundaryContext);
  const installed = appNavSink.useInstalled();
  if (bound !== null) return bound;
  return installed ? navigateApp : null;
}

/**
 * The nearest {@link AppNavBoundary}'s navigator, or `null` outside any — for
 * a higher layer's own navigation hooks (tabs' `useNavigate`), which fall back
 * to their own global rather than to the installed sink.
 */
export function useAppNavBoundary(): AppNavigator | null {
  return useContext(AppNavBoundaryContext);
}
