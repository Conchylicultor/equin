import type { ReactNode } from "react";

/**
 * A message standing in for a pane's content — a loading, empty, missing or
 * failed state — the one owner of where such a message sits in any pane.
 *
 * Inline, it opens a region on the pane's own text edge (`rail-x-pane`: the
 * pane's `--pane-inset`, the pane edge its header pads by), so the message starts where
 * the pane header's title does, whatever the pane's body is. Block, it adds
 * nothing: the message's room above and below is its own (`Placeholder`'s),
 * so a message sits the same distance under every pane header.
 *
 * A render arm that is only a state renders `<PaneChrome pane={…}>` with a
 * `PaneMessage` inside — not `inset="document"`, whose block padding would
 * stack on the message's own (research/2026-11-09-global-surface-owned-inset.md,
 * slice 3). Never nest one in another region: it would pay the inset twice.
 */
export function PaneMessage({ children }: { children: ReactNode }) {
  return <div className="rail-x-pane">{children}</div>;
}
