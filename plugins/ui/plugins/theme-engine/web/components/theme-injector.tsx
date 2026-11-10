import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { useEffect, useInsertionEffect, useMemo } from "react";
import { useScopeMembership } from "@plugins/config_v2/web";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Apps } from "@plugins/apps-core/web";
import {
  useRootThemeScopeState,
  type RootThemeScopeState,
} from "@plugins/apps-core/plugins/theme-scope/web";
import {
  appThemeScope,
  fixedThemeScope,
  subThemeScope,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { useDocumentColorMode, type ColorMode } from "../use-color-mode";
import { ThemeEngine } from "../slots";
import type { TokenGroupContribution } from "../slots";
import {
  useResolvedTheme,
  type ResolvedThemeState,
} from "../use-resolved-theme";
import {
  assertUniqueFixedThemes,
  CANVAS_STYLE_ID,
  fixedThemeGroupValues,
  renderCanvasBlock,
  renderSubThemeBlock,
  renderThemeGroupBlock,
  subThemeBlocks,
  themeSelectionConfig,
  themeStyleId,
  type ColorAdjustment,
  type FixedTheme,
  type GroupValues,
  type SkippedThemeValue,
  type SubTheme,
  type TokenGroupFragment,
  type TokenGroupSpec,
} from "../../core";
import {
  themeResolutionReportSink,
  type ThemeResolutionFault,
} from "../internal/resolution-report-sink";
import {
  claimPaintedStyle,
  releasePaintedStyle,
} from "../internal/painted-style-claims";

function GroupStyle({
  group,
  values,
  colorAdjust,
  scopeToken,
}: {
  group: TokenGroupSpec;
  // This group's resolved values, or null while the scope's theme is still
  // pending (a resident theme source or the selection loading).
  values: GroupValues | null;
  colorAdjust: ColorAdjustment | null;
  // When set, this GroupStyle emits a *scoped* override block targeting
  // `[data-theme-scope="<scopeToken>"]` instead of global `:root`/`.dark` (e.g.
  // `"app:home"` for one app with its own theme), under a `theme-scope-` id.
  scopeToken?: string;
}) {
  // Resolve straight to the final CSS text (null while the theme is pending).
  // The DOM effects below depend on this STRING, not on the value objects:
  // upstream hooks rebuild their objects across renders, and object-identity
  // deps made the effect re-run — remove + re-append its <style> — on every
  // boot commit. That churn (~64 elements per commit) let mid-task style
  // recalcs observe a theme-less document, which retriggered `transition-*` on
  // themed elements over and over: the visible "flicker until boot settles"
  // bug. A string dep makes no-op re-renders structurally unable to touch the DOM.
  const text = useMemo(
    () =>
      values === null || colorAdjust === null
        ? null
        : renderThemeGroupBlock(group, values, colorAdjust, scopeToken),
    [values, colorAdjust, group, scopeToken],
  );

  usePaintedStyle(themeStyleId(group.id, scopeToken), text);
  return null;
}

/**
 * One painted `<style>` element: `text` in the document, under `id`. `null` text
 * (a theme still loading) leaves whatever is there — the CSS the server painted
 * into the HTML for the first frame — untouched.
 *
 * Written in INSERTION effects, not layout effects: React runs every insertion
 * effect of a commit before any layout effect. A layout effect elsewhere in the
 * same commit that measures (a synchronous initial `getBoundingClientRect`)
 * forces a style recalc; had the new tokens not landed yet, the elements that
 * commit mounted would take the OUTGOING theme as their first computed style,
 * and every `transition-*` on them would then animate from it. That was the
 * sidebar visibly resizing on an app switch (Pages 16rem → Agent Manager's
 * narrower `--sidebar-panel-width`): a freshly mounted sidebar running a
 * 200 ms width transition from the previous app's width.
 */
function usePaintedStyle(id: string, text: string | null): void {
  // Element lifecycle — runs once per id, NOT on theme changes. Adopts the
  // server-painted element in place (by id) or creates it, and claims the id
  // so the prune pass keeps it. Claiming here (even while the theme is still
  // pending) also protects the server-painted CSS from a prune triggered by an
  // already-resolved sibling. The element is only removed on unmount — never
  // as part of a content update.
  useInsertionEffect(() => {
    let el = document.getElementById(id) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement("style");
      el.id = id;
      document.head.appendChild(el);
    }
    claimPaintedStyle(id);
    return () => {
      el.remove();
      releasePaintedStyle(id);
    };
  }, [id]);

  // Content update — writes textContent in place only when the rendered CSS
  // actually changed (the server painted the same bytes, so an adopted element
  // is usually left alone). Runs after the lifecycle effect above (same commit,
  // declaration order), so the element exists. While `text` is null (theme
  // pending) it leaves the server-painted CSS untouched — painting a guess here
  // would overwrite it with wrong values for one window.
  useInsertionEffect(() => {
    if (text === null) return;
    const el = document.getElementById(id);
    if (el && el.textContent !== text) el.textContent = text;
  }, [id, text]);
}

/**
 * One scope's painted blocks: a GroupStyle per registered token group, all fed
 * from ONE resolution of the scope's theme, plus the reports for anything that
 * resolution could not paint as stored.
 */
function ScopeStyles({
  scopeId,
  scopeToken,
}: {
  scopeId: string | undefined;
  scopeToken?: string;
}) {
  const groups = ThemeEngine.TokenGroup.useContributions();
  const state = useResolvedTheme(scopeId);
  useReportResolutionFaults(scopeId, state);

  return (
    <>
      {groups.map((g) => (
        <GroupStyle
          key={g.id}
          group={g.descriptor}
          values={state.pending ? null : state.theme.groups[g.id]!}
          colorAdjust={state.pending ? null : state.theme.colorAdjust}
          scopeToken={scopeToken}
        />
      ))}
    </>
  );
}

/**
 * A missing theme or dropped stored values are never silent: each distinct
 * fault is reported once per mount. Keyed on a string so a re-render with the
 * same faults reports nothing new.
 */
function useReportResolutionFaults(
  scopeId: string | undefined,
  state: ResolvedThemeState,
): void {
  const faults: ThemeResolutionFault[] = [];
  if (!state.pending) {
    if (state.missing !== undefined) {
      faults.push({ kind: "missing-theme", scopeId, themeId: state.missing });
    }
    faults.push(...skippedFaults(state.skipped));
  }
  useReportFaults(faults);
}

/** The faults for the stored values a resolution dropped. */
function skippedFaults(skipped: SkippedThemeValue[]): ThemeResolutionFault[] {
  return skipped.map((s) =>
    s.reason === "unregistered-group"
      ? { kind: "unregistered-group", themeId: s.themeId, groupId: s.groupId }
      : {
          kind: "unknown-tokens",
          themeId: s.themeId,
          groupId: s.groupId,
          tokens: s.tokens,
        },
  );
}

/** Report each distinct fault once per mount. */
function useReportFaults(faults: ThemeResolutionFault[]): void {
  const faultsKey = JSON.stringify(faults);

  useEffect(() => {
    for (const fault of JSON.parse(faultsKey) as ThemeResolutionFault[]) {
      themeResolutionReportSink.emit(fault);
    }
  }, [faultsKey]);
}

// Toggles the document's `<html>.dark` class from the resolved colour mode of
// the focused full-surface app (use-color-mode: that app's
// effective mode, or the global setting). `undefined` while that scope is not
// known yet: the class the server's first frame set stays untouched, rather
// than the desktop's answer flashing for a frame.
//
// An insertion effect for the same reason as usePaintedStyle: the class must be
// on `<html>` before any layout effect of the commit can force a style recalc.
function ColorModeApplier({ resolved }: { resolved: ColorMode | undefined }) {
  useInsertionEffect(() => {
    if (resolved === undefined) return;
    document.documentElement.classList.toggle("dark", resolved === "dark");
  }, [resolved]);

  return null;
}

export function ThemeInjector() {
  // `:root` wears ONE stable theme — the desktop's (the base document's) — and
  // never follows navigation or the surface mode. Re-rooting it on the focused
  // full-surface app (as it once did) changed inherited custom properties at the
  // root on every switch between the desktop and full screen, and so restyled
  // the whole document (~18k elements, 350–480 ms a time). Each app with its own
  // theme wears it on its own boundary instead (AppScopeThemes below; every tab
  // container is a `<Theme name="app:<id>">`). Only an edit of the desktop's
  // theme changes `:root`.
  const root = useRootThemeScopeState();
  // `<html>.dark` still follows the focused full-surface app's scheme
  // (use-color-mode): a document has one. It flips only where that app's
  // scheme differs from the desktop's — per-region schemes are deferred.
  const resolved = useDocumentColorMode();
  useDropRetiredThemeCache();

  return (
    <>
      <ColorModeApplier resolved={resolved} />
      <ScopeStyles scopeId={undefined} />
      <DocumentCanvas root={root} />
    </>
  );
}

/**
 * The document canvas: `<body>`'s background, in the focused full-surface app's
 * `--background` (the desktop's when no single app fills the surface). It is
 * what shows before the app mounts — the server paints the same block for the
 * app a page opens — so a page load never flashes the desktop's canvas under an
 * app with a theme of its own. One non-inherited property on one element, so
 * following the focused app costs a restyle of `<body>` alone.
 *
 * Held (adopting the server's element, writing nothing) until the surface says
 * which app owns it, and while that app's theme is pending.
 */
function DocumentCanvas({ root }: { root: RootThemeScopeState }) {
  const groups = ThemeEngine.TokenGroup.useContributions();
  const resolved = useResolvedTheme(root.known ? root.scopeId : undefined);
  const text = useMemo(
    () =>
      !root.known || resolved.pending
        ? null
        : renderCanvasBlock(
            groups.map((g) => g.descriptor),
            resolved.theme,
          ),
    [root.known, resolved, groups],
  );
  usePaintedStyle(CANVAS_STYLE_ID, text);
  return null;
}

// One app's scoped blocks, on `[data-theme-scope="app:<id>"]` — the boundary
// every tab container of the app is — for an app with its own theme document.
// Painted whether or not the app is focused, visible or full-surface: whatever
// the surface mode, the app's tokens live on its own boundary, never on `:root`,
// so focusing it or switching the surface mode writes no `<style>` at all.
//
// Ownership gate: ONE check per scope, on the theme selection document. An app
// with its own theme document emits blocks for every group; an app without one
// emits nothing and inherits `:root` (the desktop's theme) whole — it cannot
// own part of a theme.
//
// It reuses the same resolution, color adjustment and completeness backstop as
// the `:root` path (all live in ScopeStyles / GroupStyle) — only the selector and
// style id differ (via `scopeToken`). The server paints the same blocks into the
// first frame's HTML. Deliberately omits ColorModeApplier: a document has one
// scheme.
//
// Mounted centrally (one per registered app via AppScopeThemes at Core.Root),
// not per open surface — so the degraded `AppTabsBody` fallback and the real
// surface share the same scope blocks, with no `apps → theme-engine` cycle.
export function ScopedAppTheme({ appId }: { appId: string }) {
  const scopeId = appThemeScope(appId);
  const ownsTheme = useScopeMembership(themeSelectionConfig, scopeId);
  // No block while membership is unknown (preloaded, so only a failed boot has
  // that window): the app's surface wears `:root` until it is known. A failed
  // read keeps its last-known answer, else wears `:root` too.
  const owns = foldResource(ownsTheme, {
    loading: () => false,
    error: (_error, stale) => stale ?? false,
    ready: (member) => member,
  });
  if (!owns) return null;
  return <ScopeStyles scopeId={scopeId} scopeToken={scopeId} />;
}

// Central mount point for every registered app's scope block: one
// <ScopedAppTheme/> per `Apps.App` contribution; each emits only when its app
// owns a theme. Mounted at Core.Root — slot `useContributions()` is
// provider-free, so this needs no TabsProvider ancestor. Mounting centrally
// (rather than per open surface) is what lets the degraded `AppTabsBody`
// fallback be themed without an `apps → theme-engine` import cycle.
export function AppScopeThemes() {
  const apps = Apps.App.useContributions();
  return (
    <>
      {apps.map((app) => (
        <ScopedAppTheme key={app.id} appId={app.id} />
      ))}
    </>
  );
}

/**
 * Every contributed sub-theme's blocks: one `<style>` per fragment, targeting
 * `[data-theme-scope="sub:<id>"]` and holding ONLY the tokens that fragment
 * names — plus the tokens of the same group derived from them, re-declared so
 * they recompute inside the region (`subThemeBlockValues`). Everything else inside a sub-theme region reads the surrounding theme
 * by plain CSS inheritance — which is why a sub-theme is resolved against
 * nothing and never needs to know which theme it sits in.
 *
 * Painted for as long as a sub-theme is contributed, not when a region wearing
 * it mounts: the blocks are a handful of variables, and always being there puts
 * them in the pre-paint cache, so a region never shows one frame in the
 * surrounding theme's values before its own.
 */
export function SubThemeStyles() {
  const subThemes = ThemeEngine.SubTheme.useContributions();
  const groups = ThemeEngine.TokenGroup.useContributions();
  const { blocks, skipped } = subThemeBlocks(
    subThemes,
    groups.map((g) => g.descriptor),
  );
  useReportFaults(skippedFaults(skipped));

  return (
    <>
      {blocks.map(({ subTheme, group, fragment }) => (
        <SubThemeFragmentStyle
          key={`${subTheme.id}-${group.id}`}
          subTheme={subTheme}
          group={group}
          fragment={fragment}
        />
      ))}
    </>
  );
}

function SubThemeFragmentStyle({
  subTheme,
  group,
  fragment,
}: {
  subTheme: SubTheme;
  group: TokenGroupSpec;
  fragment: TokenGroupFragment;
}) {
  const text = useMemo(
    () => renderSubThemeBlock(group, fragment, subTheme),
    [group, fragment, subTheme],
  );
  usePaintedStyle(themeStyleId(group.id, subThemeScope(subTheme)), text);
  return null;
}

/**
 * Every contributed fixed theme's blocks: one `<style>` per token group,
 * targeting `[data-theme-scope="fixed:<id>"]` and holding the group's COMPLETE
 * values — resolved over the schema defaults exactly like a selected theme, so
 * nothing from the surrounding app's theme reaches the region.
 *
 * A fixed theme is one color scheme in both modes, so the `scheme` half of the
 * resolution is written under both the light and the dark selector.
 *
 * Painted for as long as it is contributed (not when a region wearing it
 * mounts), and never pending — it resolves against itself alone — so it is in
 * the pre-paint cache and on screen in the first commit.
 */
export function FixedThemeStyles() {
  const fixedThemes = ThemeEngine.FixedTheme.useContributions();
  const groups = ThemeEngine.TokenGroup.useContributions();
  assertUniqueFixedThemes(fixedThemes);

  return (
    <>
      {fixedThemes.map((fixed) => (
        <FixedThemeScopeStyles key={fixed.id} fixed={fixed} groups={groups} />
      ))}
    </>
  );
}

function FixedThemeScopeStyles({
  fixed,
  groups,
}: {
  fixed: FixedTheme;
  groups: readonly TokenGroupContribution[];
}) {
  const { values, colorAdjust, skipped } = useMemo(
    () =>
      fixedThemeGroupValues(
        fixed,
        groups.map((g) => g.descriptor),
      ),
    [fixed, groups],
  );
  useReportFaults(skippedFaults(skipped));
  const scopeToken = fixedThemeScope(fixed);

  return (
    <>
      {groups.map((g) => (
        <GroupStyle
          key={g.id}
          group={g.descriptor}
          values={values[g.id]!}
          colorAdjust={colorAdjust}
          scopeToken={scopeToken}
        />
      ))}
    </>
  );
}

// A store whose only job is its `legacy` key: the first touch deletes it.
const retiredThemeCache = defineStore({
  owner: "theme-engine.retired",
  pageWide: { reason: "only deletes a pre-primitive page key" },
  label: "Retired theme cache",
  area: "local",
  cap: "1 KB",
  ttl: Infinity,
  whenFull: "refuse",
  schema: z.never(),
  legacy: { match: (key) => key === "theme-engine:critical-css" },
});

/**
 * The browser used to keep a copy of the painted theme CSS in localStorage, to
 * replay before the first frame; the server now paints that frame. Removes the
 * retired copy (up to ~1 MB of the origin's shared quota) once per load;
 * delete once every browser has loaded a build with this.
 */
function useDropRetiredThemeCache(): void {
  useEffect(() => {
    // First touch scans the area and deletes the legacy key; there is nothing to read.
    retiredThemeCache.ids();
  }, []);
}
