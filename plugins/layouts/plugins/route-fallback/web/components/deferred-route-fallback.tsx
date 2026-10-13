import { useContext } from "react";
import {
  useDeferredLoadComplete,
  useHasLoadErrorUnder,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  PaneLoadScopeContext,
  useRouteState,
} from "@plugins/primitives/plugins/pane/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";

/**
 * The layout's fallback surface for a pane route that currently resolves to no
 * pane — the single home for the tri-state "pending / not-found / app-load-error"
 * distinction.
 *
 * WHY this exists: with deferred plugin loading, a cold deep-link into an app
 * (e.g. `/pages/page/<id>`) paints the app shell + surface immediately, but the
 * route's actual *pane* belongs to a plugin that loads a beat later (post-paint,
 * deferred tier). During that gap — and also when a URL is genuinely invalid or
 * its plugin chunk failed to load — the pane router matches nothing, so the
 * layout has no pane to paint. This surface reads the store's tri-state route
 * (`useRouteState`) plus the deferred-load signal to decide what to show:
 *
 * | route state              | loading            | health          | surface        |
 * | ------------------------ | ------------------ | --------------- | -------------- |
 * | resolved [] (bare root)  | —                  | —               | null (blank)   |
 * | unresolved / resolved≠[] | !deferredComplete  | —               | spinner        |
 * | unresolved / resolved≠[] | settled            | load error      | app-load error |
 * | unresolved / resolved≠[] | settled            | healthy         | not-found      |
 *
 * A `resolved` NON-empty route only reaches here when its slots don't resolve to
 * registered panes (stale paneIds from an old bundle, or a still-loading plugin),
 * so once settled it gets the SAME not-found / error treatment as an unresolved
 * URL — never a permanently blank pane. Health = a load error under THIS app's
 * plugin subtree (`PaneLoadScopeContext`); an empty scope is always healthy.
 *
 * The `Loading` primitive has a built-in ~120ms delay-before-show, so a fast
 * deferred load unmounts this before it ever paints — no flash on the warm path.
 */
export function DeferredRouteFallback() {
  const deferredComplete = useDeferredLoadComplete();
  const state = useRouteState();
  const scope = useContext(PaneLoadScopeContext);
  const hasLoadError = useHasLoadErrorUnder(scope);

  // Genuine bare app root with no index pane — render blank, as today. (An app
  // WITH an index pane never reaches the fallback; usePaneRoute returns it.)
  if (state.kind === "resolved" && state.slots.length === 0) return null;

  // Still settling → the route may resolve any moment. Show the delayed loader
  // for both a pending (unresolved) URL and a load-gap (resolved-but-unresolvable
  // slots).
  if (!deferredComplete) {
    return (
      <Center className="size-full">
        <Loading variant="spinner" label="Loading…" />
      </Center>
    );
  }

  // Settled. A plugin under this app's subtree failed to load → the app is
  // broken, not the link; offer a reload. Otherwise the URL is genuinely
  // unresolvable → not-found.
  return hasLoadError ? <AppLoadErrorSurface /> : <NotFoundSurface />;
}

/** Calm not-found surface for a settled, healthy, unresolvable URL. */
function NotFoundSurface() {
  return (
    <Center className="size-full">
      <Stack gap="2xs" align="center">
        <Text variant="heading">This page doesn't exist</Text>
        <Text variant="body" tone="muted">
          The link may be broken or the page may have been moved.
        </Text>
      </Stack>
    </Center>
  );
}

/** App-load error surface with a Retry (full reload) affordance. */
function AppLoadErrorSurface() {
  return (
    <Center className="size-full">
      <Stack gap="sm" align="center">
        <Stack gap="2xs" align="center">
          <Text variant="heading">Couldn't load this app</Text>
          <Text variant="body" tone="muted">
            Part of the app failed to load. Reloading usually fixes it.
          </Text>
        </Stack>
        <Button variant="outline" onClick={() => location.reload()}>
          Retry
        </Button>
      </Stack>
    </Center>
  );
}
