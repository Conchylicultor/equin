import type { ReactNode } from "react";
import { reachesAudience, type Audience } from "@plugins/audience/core";
import { useAudience } from "@plugins/audience/web";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import {
  DeveloperBadge,
  DeveloperCorner,
  DeveloperMark,
} from "./developer-mark";

/**
 * How a gated thing wears the developer mark, chosen by what it is:
 *
 * - `badge` — a small control (an icon button): the bare symbol on its corner.
 * - `label` — control-panel rows: the pill after each row label inside.
 * - `corner` — a tile filling its box: the pill overhanging its corner.
 * - `inline` — a run of text or chips: the pill after it.
 */
export type AudienceMark = "badge" | "label" | "corner" | "inline";

function marked(mark: AudienceMark, children: ReactNode): ReactNode {
  switch (mark) {
    case "badge":
      return <DeveloperBadge>{children}</DeveloperBadge>;
    case "label":
      return (
        <ControlPanel.LabelMark mark={<DeveloperMark />}>
          {children}
        </ControlPanel.LabelMark>
      );
    case "corner":
      return <DeveloperCorner developer>{children}</DeveloperCorner>;
    case "inline":
      return (
        <>
          {children} <DeveloperMark />
        </>
      );
  }
}

/**
 * Renders `children` only for the audience a feature declares itself for
 * (`audience`, omitted = everyone) — the declarative gate a host wraps each
 * contribution of an audience-aware slot in, so a contributor states who it is
 * for instead of branching on Developer mode itself.
 *
 * The gate draws the developer mark too, in the form `mark` names (required):
 * what only a developer is shown is marked by the same step that hides it from
 * everyone else, so nothing can be developer-only and unmarked.
 *
 * `shownWhile` keeps a developer-only thing shown — still marked — to whoever
 * the user is while it is true: a switch whose own state changes the audience
 * (the git-defaults preview reads a new user's Developer mode, off) must stay
 * reachable to be turned back off.
 *
 * Nothing renders while the audience is unknown: whether a control exists is
 * the question, so there is no stand-in to show (the config is boot-preloaded,
 * so the window is not observable after boot). A failed read throws to the
 * nearest error boundary.
 */
export function ForAudience({
  audience,
  mark,
  shownWhile = false,
  children,
}: {
  audience: Audience | undefined;
  mark: AudienceMark;
  shownWhile?: boolean;
  children: ReactNode;
}) {
  const user = useAudience();
  if (audience === undefined || audience === "user") return children;
  if (shownWhile) return marked(mark, children);
  if (user.status === "error") throw user.error;
  if (user.status === "loading") return null;
  return reachesAudience(audience, user.data) ? marked(mark, children) : null;
}
