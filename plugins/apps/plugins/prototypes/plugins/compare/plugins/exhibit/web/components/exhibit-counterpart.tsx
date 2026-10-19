import type { ReactElement, ReactNode } from "react";
import {
  ExhibitView,
  useExhibit,
  type ExhibitResult,
} from "@plugins/plugin-meta/plugins/exhibits/web";
import {
  Apps,
  resolveAppForPath,
  type ActiveApp,
} from "@plugins/apps-core/web";
import { appThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import type {
  CounterpartKindProps,
  CounterpartResolution,
} from "@plugins/apps/plugins/prototypes/plugins/compare/web";

/**
 * The `exhibit:` kind: one real app component, looked up by id in the exhibit
 * catalog and rendered inside this app's own React tree — so an app exhibit's
 * slot contributions, config and data are the real ones, and an isolated one
 * renders exactly as it does anywhere else.
 *
 * `exhibit:<id>@<app path>` renders it inside that app's theme boundary
 * (`exhibit:ui-kit/menu-sheet@/agents` — the menus as the agent manager draws
 * them), so a mock of one app's look is compared against that app's real
 * theme rather than the Prototypes app's own.
 */
export function ExhibitCounterpart({
  target,
  children,
}: CounterpartKindProps): ReactElement {
  const { id, appPath } = parseTarget(target);
  const lookup = useExhibit(id);
  const apps = Apps.App.useContributions();
  return <>{children(resolve(id, appPath, lookup, apps))}</>;
}

/** `<id>` or `<id>@<app path>`. Exhibit ids are `<group>/<name>` and never hold an `@`. */
function parseTarget(target: string): {
  id: string;
  appPath: string | undefined;
} {
  const at = target.indexOf("@");
  if (at === -1) return { id: target, appPath: undefined };
  return { id: target.slice(0, at), appPath: target.slice(at + 1) };
}

type AppLookup =
  | { kind: "none" }
  | { kind: "found"; app: ActiveApp }
  | { kind: "unresolved"; resolution: CounterpartResolution };

function lookupApp(
  appPath: string | undefined,
  apps: readonly ActiveApp[],
): AppLookup {
  if (appPath === undefined) return { kind: "none" };
  if (!appPath.startsWith("/")) {
    return {
      kind: "unresolved",
      resolution: {
        status: "unresolved",
        title: (
          <>
            <Badge mono>{appPath}</Badge> is not an app path.
          </>
        ),
        detail:
          "After the @ comes the app the exhibit is shown in, as its in-app path starting with a slash — e.g. exhibit:ui-kit/menu-sheet@/agents for the agent manager.",
      },
    };
  }
  const resolved = resolveAppForPath(appPath, apps);
  if (resolved === undefined) {
    return {
      kind: "unresolved",
      resolution: {
        status: "unresolved",
        title: (
          <>
            No app in this worktree owns <Badge mono>{appPath}</Badge>.
          </>
        ),
        detail:
          "The exhibit is shown in the theme of the app that owns this path. Prototypes are shared by every worktree while apps are per-worktree code, so a prototype can name an app that only exists on another branch.",
      },
    };
  }
  return { kind: "found", app: resolved.app };
}

function resolve(
  id: string,
  appPath: string | undefined,
  lookup: ExhibitResult,
  apps: readonly ActiveApp[],
): CounterpartResolution {
  const app = lookupApp(appPath, apps);
  if (app.kind === "unresolved") return app.resolution;
  switch (lookup.kind) {
    // The catalog loads once per page. Until it has, "no such exhibit" would
    // be a claim about this prototype that then reverses itself.
    case "loading":
      return { status: "loading", label: "Loading the exhibit catalog…" };
    case "missing":
      return {
        status: "unresolved",
        title: (
          <>
            This prototype mocks <Badge mono>{id}</Badge>, which no plugin in
            this worktree exhibits.
          </>
        ),
        detail:
          "Prototypes live outside the repo and are shared by every worktree, while exhibits are per-branch code — so a prototype can name one that only exists on another branch. A plugin exhibits a component from its own exhibits/ folder, under that id.",
      };
    case "ambiguous":
      return {
        status: "unresolved",
        title: (
          <>
            Several exhibits claim <Badge mono>{id}</Badge>.
          </>
        ),
        detail: `Exhibit ids must be unique; ${String(lookup.exhibits.length)} exhibits use this one (${lookup.exhibits.map((e) => e.label).join(", ")}). Rename all but one.`,
      };
    case "found": {
      const { exhibit } = lookup;
      // The frame is already the canvas's size, so no width is forced here;
      // ExhibitView brings the exhibit's own error boundary.
      const view = <ExhibitView exhibit={exhibit} />;
      return {
        status: "found",
        title: exhibit.label,
        ...(exhibit.description === undefined
          ? {}
          : { subtitle: exhibit.description }),
        badge:
          app.kind === "found"
            ? `${exhibit.id} · ${app.app.app.name}`
            : exhibit.id,
        render: () => (app.kind === "found" ? inAppTheme(app.app, view) : view),
      };
    }
  }
}

/**
 * The exhibit inside the app's theme boundary — its tokens, icon style and
 * canvas, carried into every menu it opens — filling the frame so the app's
 * canvas, not the Prototypes app's, is what shows around it.
 */
function inAppTheme(app: ActiveApp, view: ReactNode): ReactElement {
  return (
    <Theme
      name={appThemeScope(app.app.id)}
      surface="canvas"
      className="min-h-full"
    >
      {view}
    </Theme>
  );
}
