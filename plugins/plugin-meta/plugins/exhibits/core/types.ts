import type { ComponentType, ReactElement, ReactNode } from "react";
import type { GeometrySpec } from "@plugins/primitives/plugins/css/plugins/layout-harness/plugins/geometry/core";
import type { AppRef } from "@plugins/primitives/plugins/pane/core";

// ── The exhibit ────────────────────────────────────────────────────
//
// An exhibit is one REAL component a plugin shows on its own, so another
// surface (a gallery, a prototype's Real app frame, the geometry harness) can
// render it standalone. Which runtime it needs is the discriminant:
//
// - `isolated`        renders anywhere — a bare page with no plugin runtime
//                     included — so it can carry `geometry` for the layout
//                     harness to measure.
// - `isolated-region` the same, but it renders a HOLE: `render(children)` places
//                     children it does not choose (the harness's region kit).
// - `app`             needs the running app (slots, config, live data). Its
//                     component sits behind `load()`, so reading the catalog
//                     never evaluates app-runtime code, and it can carry no
//                     geometry: the bare measurer page cannot render it.
//
// The contract every exhibit meets: standalone (any width, no ancestor but the
// app), self-contained state seeded from the real host's defaults, and an
// exhibit rather than a working copy — it never submits, navigates or writes.

/**
 * Where the component really lives, so a viewer shows it in that place's theme
 * by default rather than in the viewer's own: an app (its `defineApp` ref —
 * data, never a restated id), or `"chrome"`, the app chrome's fixed theme (the
 * rail, tab bar, action bar and the popovers they open). Absent = it lives in
 * no one app (a primitive), and the viewer's own theme is as good as any.
 */
export type ExhibitHome = AppRef | "chrome";

/** Container widths (px) the exhibit has something to say about. */
export type ExhibitWidths = readonly [number, ...number[]];

interface ExhibitBase {
  /** `<group>/<name>`, globally unique. The group is the id's prefix. */
  id: string;
  /** What a person calls it: "Task composer (Improve)". */
  label: string;
  description?: string;
  home?: ExhibitHome;
}

export interface IsolatedExhibit extends ExhibitBase {
  runtime: "isolated";
  widths: ExhibitWidths;
  /** The REAL component. Author `data-geo="<slot>"` on boxes `geometry` measures. */
  render: () => ReactElement;
  /** Present ⇒ the layout harness measures this exhibit across `widths`. */
  geometry?: GeometrySpec;
}

export interface RegionExhibit extends ExhibitBase {
  runtime: "isolated-region";
  widths: ExhibitWidths;
  /**
   * Render the region with the given children inside it — and NOTHING else in
   * the hole. The consumer chooses the children (the layout harness passes its
   * region kit), which is the point: a region cannot pick the child kinds it is
   * gated against.
   */
  render: (children: ReactNode) => ReactElement;
}

export interface AppExhibit extends ExhibitBase {
  runtime: "app";
  /** Optional: a consumer supplies its own when absent. */
  widths?: ExhibitWidths;
  /** The component, loaded only when rendered (it needs the live app). */
  load: () => Promise<{ default: ComponentType }>;
  geometry?: never;
}

export type Exhibit = IsolatedExhibit | RegionExhibit | AppExhibit;
export type ExhibitRuntime = Exhibit["runtime"];

// ── Factories ──────────────────────────────────────────────────────
//
// Contributors author exhibits through these, never as raw literals, so each
// arm's input type is the whole contract: `appExhibit` takes `geometry?: never`,
// which makes passing a GeometrySpec a tsc error rather than a field the
// harness silently ignores.

export function isolatedExhibit(
  spec: Omit<IsolatedExhibit, "runtime">,
): IsolatedExhibit {
  return { ...spec, runtime: "isolated" };
}

export function regionExhibit(
  spec: Omit<RegionExhibit, "runtime">,
): RegionExhibit {
  return { ...spec, runtime: "isolated-region" };
}

export interface AppExhibitSpec extends ExhibitBase {
  widths?: ExhibitWidths;
  load: () => Promise<{ default: ComponentType }>;
  /** An app exhibit cannot be measured on the bare page — no geometry. */
  geometry?: never;
}

export function appExhibit(spec: AppExhibitSpec): AppExhibit {
  const { id, label, description, home, widths, load } = spec;
  return {
    runtime: "app",
    id,
    label,
    load,
    ...(description === undefined ? {} : { description }),
    ...(home === undefined ? {} : { home }),
    ...(widths === undefined ? {} : { widths }),
  };
}

// ── Validation (the registry loader's `isItem`) ────────────────────

const ID_RE = /^[^/\s]+\/\S+$/;

function isHome(v: unknown): v is ExhibitHome {
  return (
    v === "chrome" ||
    (typeof v === "object" &&
      v !== null &&
      typeof (v as Partial<AppRef>).id === "string" &&
      typeof (v as Partial<AppRef>).name === "string")
  );
}

function isWidths(v: unknown): v is ExhibitWidths {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((w) => typeof w === "number" && w > 0)
  );
}

/**
 * Validates a contributed default-export item. Checks the load-bearing shape
 * per arm, so a malformed contribution fails the (strict) registry load instead
 * of rendering as nothing.
 */
export function isExhibit(v: unknown): v is Exhibit {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Partial<
    Record<keyof IsolatedExhibit | keyof AppExhibit, unknown>
  >;
  if (typeof e.id !== "string" || !ID_RE.test(e.id)) return false;
  if (typeof e.label !== "string" || e.label === "") return false;
  if (e.description !== undefined && typeof e.description !== "string")
    return false;
  if (e.home !== undefined && !isHome(e.home)) return false;
  switch (e.runtime) {
    case "isolated":
      return (
        isWidths(e.widths) &&
        typeof e.render === "function" &&
        (e.geometry === undefined ||
          (typeof e.geometry === "object" &&
            e.geometry !== null &&
            Array.isArray((e.geometry as GeometrySpec).invariants)))
      );
    case "isolated-region":
      return isWidths(e.widths) && typeof e.render === "function";
    case "app":
      return (
        (e.widths === undefined || isWidths(e.widths)) &&
        typeof e.load === "function" &&
        e.geometry === undefined
      );
    default:
      return false;
  }
}

/** The exhibit's group: its id's prefix (`task-draft/composer` → `task-draft`). */
export function exhibitGroupOf(id: string): string {
  const slash = id.indexOf("/");
  if (slash <= 0) {
    throw new Error(`exhibit id "${id}" is not "<group>/<name>"`);
  }
  return id.slice(0, slash);
}
