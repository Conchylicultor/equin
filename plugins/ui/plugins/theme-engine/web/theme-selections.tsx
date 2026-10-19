import { useLayoutEffect, useSyncExternalStore } from "react";
import { useConfigResult, useScopeMembership } from "@plugins/config_v2/web";
import { Apps } from "@plugins/apps-core/web";
import { appThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { DEFAULT_THEME_ID, themeSelectionConfig, type ThemeId } from "../core";

/** One scope that chose a theme: the desktop (`scopeId` undefined) or an app with its own theme document. */
export interface ThemeSelection {
  scopeId: string | undefined;
  themeId: ThemeId;
}

export type ThemeSelectionsState =
  { pending: true } | { pending: false; selections: readonly ThemeSelection[] };

// What one scope reported: still loading, not a theme owner (it inherits the
// desktop's choice), or the theme it selects.
type ScopeReport =
  | { kind: "pending" }
  | { kind: "inherits" }
  | { kind: "selects"; themeId: ThemeId };

// Module-level because the reporters and the readers live in different React
// subtrees (the collector is a Core.Root; a reader is anywhere) — the same
// reason the paint-cache aggregator is module-level. Keyed by scope ("" = the
// desktop). `expected` is the scope set the collector renders a reporter for,
// so a scope that has not reported yet reads as pending rather than absent.
const reports = new Map<string, ScopeReport>();
const expected = new Set<string>();
const listeners = new Set<() => void>();
const PENDING: ThemeSelectionsState = { pending: true };
// eslint-disable-next-line scoped-store/no-module-mutable-store -- intentionally page-global, not per-surface: it holds the ONE set of theme selections of this page (the desktop's and each app's config), reported by the one Core.Root collector — every surface must read the same answer. Not an installed sink either: nothing installs an implementation; this is the memoized snapshot useSyncExternalStore requires, rebuilt only by this module's publish().
let snapshot: ThemeSelectionsState = PENDING;

const keyOf = (scopeId: string | undefined) => scopeId ?? "";

function publish(): void {
  snapshot = buildSnapshot();
  for (const listener of listeners) listener();
}

function buildSnapshot(): ThemeSelectionsState {
  if (expected.size === 0) return PENDING;
  const selections: ThemeSelection[] = [];
  for (const key of expected) {
    const report = reports.get(key);
    if (report === undefined || report.kind === "pending") return PENDING;
    if (report.kind === "selects") {
      selections.push({
        scopeId: key === "" ? undefined : key,
        themeId: report.themeId,
      });
    }
  }
  return { pending: false, selections };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => snapshot;

/**
 * Every scope's theme choice: the desktop's, plus every app that has its own
 * theme document (an app without one inherits the desktop's, so it is covered
 * by the desktop's entry rather than listed). The desktop is always first.
 *
 * Pending until every scope's choice is known. Reads what the always-mounted
 * `ThemeSelectionsCollector` reports, so it is cheap to call anywhere.
 */
export function useThemeSelections(): ThemeSelectionsState {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Resolves once no scope selects `themeId` — at once when none does now.
 *
 * For code outside React that has just moved scopes off a theme (a delete that
 * reassigns them to Default) and must not drop the theme from the theme list
 * until every scope's new choice has arrived: in between, a scope would select
 * a theme the list does not have, and the painter would report it missing.
 * Pending selections are not an answer yet, so they keep it waiting.
 */
export function whenNoScopeSelects(themeId: ThemeId): Promise<void> {
  const released = () =>
    !snapshot.pending &&
    snapshot.selections.every((s) => s.themeId !== themeId);
  if (released()) return Promise.resolve();
  return new Promise((resolve) => {
    const listener = () => {
      if (!released()) return;
      listeners.delete(listener);
      resolve();
    };
    listeners.add(listener);
  });
}

/** Reports one scope's choice into the store while mounted. */
function ScopeReporter({ scopeId }: { scopeId: string | undefined }) {
  // The desktop always owns its choice; an app only once it has its own doc.
  // Membership is preloaded and kept, so it is known on the first frame after a
  // successful boot; while it is not, an app's report is pending — whether it
  // inherits is exactly what is unknown.
  const member = useScopeMembership(themeSelectionConfig, scopeId);
  const selection = useConfigResult(themeSelectionConfig, { scopeId });
  // A failed membership read keeps its last-known answer, else stays unknown.
  const owns: boolean | "unknown" =
    scopeId === undefined
      ? true
      : foldResource(member, {
          loading: (): boolean | "unknown" => "unknown",
          error: (_error, stale): boolean | "unknown" => stale ?? "unknown",
          ready: (isMember) => isMember,
        });

  useLayoutEffect(() => {
    const key = keyOf(scopeId);
    let report: ScopeReport;
    if (owns === "unknown") report = { kind: "pending" };
    else if (!owns) report = { kind: "inherits" };
    else {
      // A failed read reports what the painter paints for it (the stale
      // selection, else Default — see useResolvedTheme), so every reader of
      // the selections agrees with the screen; the failure is reported by
      // live-state's resource-error sink.
      report = foldResource(selection, {
        loading: (): ScopeReport => ({ kind: "pending" }),
        error: (_error, stale): ScopeReport => ({
          kind: "selects",
          themeId: stale?.theme ?? DEFAULT_THEME_ID,
        }),
        ready: (data): ScopeReport => ({
          kind: "selects",
          themeId: data.theme,
        }),
      });
    }
    reports.set(key, report);
    publish();
    return () => {
      reports.delete(key);
      publish();
    };
  }, [scopeId, owns, selection]);

  return null;
}

/**
 * The always-mounted source of `useThemeSelections`: one reporter for the
 * desktop and one per registered app. Mounted at Core.Root beside the painter,
 * which needs no TabsProvider (slot contributions are provider-free).
 */
export function ThemeSelectionsCollector() {
  const apps = Apps.App.useContributions();
  const scopeIds = [undefined, ...apps.map((app) => appThemeScope(app.id))];
  const scopeKey = scopeIds.map(keyOf).join("\n");

  // Declares the scope set AFTER the reporters' own layout effects of the same
  // commit, so the first snapshot already has every report it waits for.
  useLayoutEffect(() => {
    const keys = scopeKey.split("\n");
    for (const key of keys) expected.add(key);
    publish();
    return () => {
      for (const key of keys) expected.delete(key);
      publish();
    };
  }, [scopeKey]);

  return (
    <>
      {scopeIds.map((scopeId) => (
        <ScopeReporter key={keyOf(scopeId)} scopeId={scopeId} />
      ))}
    </>
  );
}
