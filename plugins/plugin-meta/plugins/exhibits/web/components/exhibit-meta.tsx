import type { ReactElement } from "react";
import type {
  Exhibit,
  ExhibitRuntime,
  ExhibitWidths,
} from "@plugins/plugin-meta/plugins/exhibits/core";
import {
  Badge,
  type BadgeVariant,
} from "@plugins/primitives/plugins/css/plugins/badge/web";

// An app exhibit may declare no widths ("a consumer supplies its own"): the
// viewer shows it at a narrow, a medium and a wide container.
const APP_FALLBACK_WIDTHS: ExhibitWidths = [360, 640, 960];

export const RUNTIME_BADGE: Record<
  ExhibitRuntime,
  { label: string; variant: BadgeVariant }
> = {
  isolated: { label: "isolated", variant: "muted" },
  "isolated-region": { label: "region", variant: "info" },
  app: { label: "app", variant: "primary" },
};

/** Where the exhibit lives, in words: an app's name, the app chrome, or nowhere in particular. */
export function homeLabelOf(exhibit: Exhibit): string {
  const { home } = exhibit;
  if (home === undefined) return "Any";
  return home === "chrome" ? "App chrome" : home.name;
}

export function widthsOf(exhibit: Exhibit): ExhibitWidths {
  return exhibit.widths ?? APP_FALLBACK_WIDTHS;
}

/**
 * Whether the layout harness measures it: a region always (the harness
 * supplies the invariants), an isolated exhibit only when it declares geometry.
 */
export function isMeasured(exhibit: Exhibit): boolean {
  return (
    exhibit.runtime === "isolated-region" ||
    (exhibit.runtime === "isolated" && exhibit.geometry !== undefined)
  );
}

export function ExhibitBadges({ exhibit }: { exhibit: Exhibit }): ReactElement {
  const runtime = RUNTIME_BADGE[exhibit.runtime];
  return (
    <>
      <Badge variant={runtime.variant}>{runtime.label}</Badge>
      {isMeasured(exhibit) ? <Badge variant="success">geometry</Badge> : null}
    </>
  );
}
