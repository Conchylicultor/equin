import type { ReactNode } from "react";
import { spaceLength } from "@plugins/primitives/plugins/css/plugins/space-ramp/core";
import type { ToolbarArrangement, ToolbarParts } from "../../../core";
import { PillsToolbar } from "./pills-toolbar";

/**
 * The default wide toolbar: one in-flow row of [title] [views pill] ···
 * [tools pill: search · controls · actions | create] — {@link PillsToolbar}
 * on the in-flow band (on the rail, a small gap above and below).
 */
function BarToolbar(parts: ToolbarParts): ReactNode {
  return <PillsToolbar {...parts} />;
}

/** The default arrangement — see {@link BarToolbar}. */
export const barArrangement: ToolbarArrangement = {
  id: "bar",
  // `filled`: the search is a quiet well inside the tools pill, which already
  // draws the edge.
  forms: { search: "filled", controls: "ghost", creators: "labelled" },
  component: BarToolbar,
  // The fade's runway. The host hangs a `--sticky-fade-tail` gradient under
  // the band; at rest the first row must start where it has faded out, or
  // the top of an unscrolled list reads washed out. It stops one `sm` short
  // of the tail: the tail's last stretch is near-transparent, and the pills
  // already sit `py-sm` inside the band.
  spaceBelow: `calc(var(--sticky-fade-tail) - ${spaceLength("sm")})`,
};
