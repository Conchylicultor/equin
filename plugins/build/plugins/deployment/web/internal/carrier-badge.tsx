import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import type React from "react";
import type { Resolvable } from "@plugins/primitives/plugins/live-state/core";
import { sameCommit, type Carrier, type CarrierId } from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const differenceIcon = symbol("difference");

/** How each carrier is named to a human. Display metadata, so it lives in web. */
export const CARRIER_LABEL: Record<CarrierId, string> = {
  server: "Server",
  web: "Web",
  tab: "This tab",
};

/**
 * The graph hash the server is serving RIGHT NOW — the `web` carrier's pin.
 *
 * It is the reference every other carrier's bytes are compared against, and it
 * is the only defensible one: `web` is what a reload would give you, so a
 * carrier disagreeing with it is a carrier running something you can no longer
 * get. `null` when the served dist carries no `.build-graph`, in which case
 * nothing is compared — an absent reference can never manufacture a mismatch.
 */
export function servedGraph(carriers: Carrier[]): string | null {
  const web = carriers.find((c) => c.id === "web");
  return web !== undefined && web.graph.resolved ? web.graph.value : null;
}

/**
 * Is this carrier at the right commit but running the wrong bytes?
 *
 * Both halves are true at once, and that is the whole point: a bundle's commit
 * and its content identity are two independent pins, and a rebuild of the same
 * tree with a changed dependency (or a tab holding a bundle the server has
 * since replaced) moves the second without the second's commit budging. A badge
 * that showed only one of them would be lying either way round — "up to date"
 * when the bytes differ, or "behind" when the commit does not.
 *
 * `web` is never flagged: it IS the reference.
 */
export function hasOtherBytes(
  carrier: Carrier,
  served: string | null,
): boolean {
  if (carrier.id === "web" || served === null) return false;
  return carrier.graph.resolved && carrier.graph.value !== served;
}

/**
 * The commit a carrier's chip sits on in the chain.
 *
 * Normally the commit it was built at. The exception is the tab running the
 * SAME bytes as the served bundle: a commit that changed nothing the browser
 * runs (a server- or CLI-only change) rebuilds the dist with an unchanged graph
 * hash, so the tab is not behind in any way a reload could fix. Its chip then
 * sits with `web` — the newest commit known to compose those exact bytes —
 * rather than on its own older build commit, where it would read as "stale"
 * next to a Build button correctly offering no Reload. Both surfaces now ask the
 * same question (graph hash vs the served one), so they cannot disagree.
 *
 * Only the served graph is ever compared: it is the one fingerprint whose commit
 * we know. The tab's own build commit is not lost — the chip's hover names it.
 */
export function placementCommit(
  carrier: Carrier,
  carriers: Carrier[],
): Resolvable<string> {
  if (carrier.id !== "tab" || !carrier.graph.resolved) return carrier.commit;
  const web = carriers.find((c) => c.id === "web");
  if (
    web === undefined ||
    !web.graph.resolved ||
    !web.commit.resolved ||
    web.graph.value !== carrier.graph.value
  ) {
    return carrier.commit;
  }
  return web.commit;
}

/** Is this carrier pinned to `commit`? False for a carrier that cannot say. */
export function isAtCommit(carrier: Carrier, commit: string): boolean {
  return carrier.commit.resolved && sameCommit(carrier.commit.value, commit);
}

/**
 * One carrier's chip, pinned to the row of the commit it is actually on.
 *
 * The chip's POSITION says which commit the carrier is at; its LABEL says
 * whether the bytes there are the ones being served. The "same commit,
 * different bytes" case needs both statements, so it gets both — a chip that
 * still sits on that commit's row, and a label that names the disagreement.
 *
 * The distance is NOT in the label. It is a fact about the ROW — every carrier
 * sitting on a commit is exactly as far behind as that commit is — so printing
 * it per chip said the same number up to three times on one line, and the three
 * "· N behind" suffixes were what pushed the commit subject off the row
 * entirely. It is already stated twice over: the section's verdict counts the
 * commits to deploy, and the rail position IS the distance. What is left is the
 * one place it is worth being exact — the hover, next to the full sha.
 */
export function CarrierBadge({
  carrier,
  atTarget,
  otherBytes,
  behind,
  rowSha,
}: {
  carrier: Carrier;
  atTarget: boolean;
  otherBytes: boolean;
  behind: number;
  /** The commit of the row the chip sits on (see `placementCommit`). */
  rowSha: string;
}) {
  const label = CARRIER_LABEL[carrier.id];
  const at = !carrier.commit.resolved
    ? carrier.commit.reason
    : sameCommit(carrier.commit.value, rowSha)
      ? carrier.commit.value
      : `same bundle as this commit, built at ${carrier.commit.value}`;
  const distance =
    behind > 0
      ? `${behind} ${behind === 1 ? "commit" : "commits"} behind HEAD`
      : "at HEAD";
  if (otherBytes) {
    return (
      <Badge
        variant="warning"
        icon={<Icon icon={differenceIcon} />}
        tooltip={`${label} is at this commit (${distance}), but running a different bundle than the one now served — the same tree can compose different bytes. Reload to pick up the served one.`}
      >
        {label}
      </Badge>
    );
  }
  return (
    <Badge
      variant={atTarget ? "success" : "muted"}
      tooltip={`${label} — ${distance} · ${at}`}
    >
      {label}
    </Badge>
  );
}

/**
 * The chips for one commit row, `behind` commits back from the target. Rigid and
 * non-wrapping: in a popover-width bar
 * the identity chips keep their size and the commit subject beside them is what
 * truncates.
 *
 * Returns `undefined` (not an empty box) when no carrier sits here, so a row
 * with no marker renders exactly as it did before this prop existed.
 */
export function carrierMarkers(
  carriers: Carrier[],
  rowSha: string,
  target: string | null,
  served: string | null,
  behind: number,
): React.ReactNode | undefined {
  if (carriers.length === 0) return undefined;
  return (
    <Inline gap="2xs" className={rigidClass()}>
      {carriers.map((c) => (
        <CarrierBadge
          key={c.id}
          carrier={c}
          // The chip sits on this row, so it is at the target iff the row is.
          atTarget={target !== null && sameCommit(rowSha, target)}
          otherBytes={hasOtherBytes(c, served)}
          behind={behind}
          rowSha={rowSha}
        />
      ))}
    </Inline>
  );
}
