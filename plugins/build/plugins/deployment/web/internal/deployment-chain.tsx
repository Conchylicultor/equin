import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { CommitRowItem } from "@plugins/primitives/plugins/commit-list/web";
import { OpenCommitConversation } from "@plugins/conversations/plugins/commit-conversation/web";
import type { CommitRow } from "@plugins/primitives/plugins/commit-list/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type React from "react";
import type { Resolvable } from "@plugins/primitives/plugins/live-state/core";
import {
  CHAIN_CAP,
  sameCommit,
  type Carrier,
  type Chain,
  type DeploymentState,
} from "../../core";
import {
  CARRIER_LABEL,
  carrierMarkers,
  hasOtherBytes,
  isAtCommit,
  placementCommit,
  servedGraph,
} from "./carrier-badge";
import { useChainFrom, type ChainFromReading } from "./use-chain-from";
import { useDeployment } from "./use-deployment";

// Two bands, mirroring the conversation commits-graph: the stretch nothing has
// picked up yet, and the stretch that is running somewhere.
const TO_DEPLOY_COLOR = "var(--primary)";
const DEPLOYED_COLOR = "var(--success)";

function short(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * The verdict's colour. A class map rather than `Text`'s `tone` prop, which has
 * no `success` arm — and "everything is deployed" is exactly the statement that
 * needs one.
 */
const TONE_CLASS = {
  success: "text-success",
  primary: "text-primary-text",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
} as const;

/** The section shell: one label, one verdict, and whatever evidence the arm has. */
function Section({
  summary,
  tone,
  children,
}: {
  summary: string;
  tone: keyof typeof TONE_CLASS;
  children: React.ReactNode;
}) {
  return (
    <Stack gap="none" className="border-b">
      <Line className="gap-sm px-md py-sm">
        <Text as="span" variant="label" className="text-muted-foreground">
          Deployment
        </Text>
        {/* An empty Fill absorbs the slack, so the verdict sits in its own
            flush-right track rather than floating over the label. */}
        <Fill />
        <Text as="span" variant="caption" className={TONE_CLASS[tone]}>
          {summary}
        </Text>
      </Line>
      {children}
    </Stack>
  );
}

/**
 * The carriers that landed on no row at all, rendered explicitly BELOW the
 * chain rather than dropped.
 *
 * Dropping one would be the worst kind of quiet: a missing badge reads as "there
 * is no such carrier", and "this tab has no bundle" is never true of a tab you
 * are looking at. So each one still says its name, and then the most specific
 * true thing available about its commit.
 *
 * Reaching here at all means something stopped the chain from covering the
 * carrier, so the sentence comes from whatever knows why — the extension's own
 * failure reason, or the cap that cut the walk short — rather than a fixed line
 * guessing at it.
 */
function OffChain({
  carriers,
  reading,
  truncated,
}: {
  carriers: Carrier[];
  reading: ChainFromReading;
  truncated: boolean;
}) {
  if (carriers.length === 0) return null;
  return (
    <Stack gap="2xs" className="px-md py-sm">
      {carriers.map((c) => (
        <Line key={c.id} className="gap-sm">
          <Badge variant="muted">{CARRIER_LABEL[c.id]}</Badge>
          {c.commit.resolved ? (
            <>
              <Text
                as="span"
                variant="caption"
                className="font-mono"
                title={c.commit.value}
              >
                {short(c.commit.value)}
              </Text>
              {reading.kind === "pending" ? (
                // Not yet known is a state, never a claim: saying the commit is
                // not on the chain while we are still asking is a sentence that
                // reverses itself a moment later.
                <Loading variant="text" label="placing this commit…" />
              ) : reading.kind === "failed" ? (
                <ResourceErrorInline
                  variant="inline"
                  subject="where this commit sits"
                  error={reading.error}
                  refetch={reading.refetch}
                />
              ) : (
                <Text as="span" variant="caption" tone="muted">
                  {reading.kind === "unplaceable"
                    ? reading.reason
                    : reading.kind === "unavailable"
                      ? reading.message
                      : truncated
                        ? `more than ${CHAIN_CAP} commits behind`
                        : "not among the commits above"}
                </Text>
              )}
            </>
          ) : (
            <Text
              as="span"
              variant="caption"
              tone="muted"
              title={c.commit.reason}
            >
              {c.commit.reason}
            </Text>
          )}
        </Line>
      ))}
    </Stack>
  );
}

/**
 * Every pin, flat — the shape both unanswerable arms fall back to. There is no
 * line to draw on either (`diverged` carries no chain because there is no line;
 * `unknown` has no target to draw one toward), but the pins are still facts and
 * are still worth reading.
 */
function PinList({
  carriers,
  target,
  served,
}: {
  carriers: Carrier[];
  target: string | null;
  served: string | null;
}) {
  return (
    <Stack gap="2xs" className="px-md py-sm">
      {target !== null && (
        <Line className="gap-sm">
          <Badge variant="primary">HEAD</Badge>
          <Text
            as="span"
            variant="caption"
            className="font-mono"
            title={target}
          >
            {short(target)}
          </Text>
        </Line>
      )}
      {carriers.map((c) => (
        <Line key={c.id} className="gap-sm">
          <Badge
            variant={
              target !== null && isAtCommit(c, target) ? "success" : "muted"
            }
          >
            {CARRIER_LABEL[c.id]}
          </Badge>
          {c.commit.resolved ? (
            <Text
              as="span"
              variant="caption"
              className="font-mono"
              title={c.commit.value}
            >
              {short(c.commit.value)}
            </Text>
          ) : (
            <Text
              as="span"
              variant="caption"
              tone="muted"
              title={c.commit.reason}
            >
              {c.commit.reason}
            </Text>
          )}
          {hasOtherBytes(c, served) && (
            <Badge variant="warning">other bytes</Badge>
          )}
        </Line>
      ))}
    </Stack>
  );
}

/**
 * The row a carrier sits on, or -1. The narrowed sha is given a NAME rather than
 * read inside the callback: `c.commit.resolved` narrows `c.commit` here, but the
 * closure re-widens it to the union, so the discriminated union stays honest only
 * if the value is pulled out first. That is the union doing its job, not an
 * obstacle to cast around.
 */
function rowOf(rows: CommitRow[], commit: Resolvable<string>): number {
  if (!commit.resolved) return -1;
  const sha = commit.value;
  return rows.findIndex((r) => sameCommit(r.sha, sha));
}

/**
 * The commit to extend the chain back to.
 *
 * There is at most one candidate, and that is structural rather than lucky: the
 * server's chain runs from the oldest DEPLOYABLE pin up to the target, so a
 * deployable carrier is always on it by construction, and the tab is the only
 * other carrier there is. A carrier that cannot name a commit is skipped — there
 * is nothing to walk from, and its own reason is already what gets rendered.
 */
function extensionBase(
  offChain: Carrier[],
  carriers: Carrier[],
): string | null {
  for (const c of offChain) {
    const commit = placementCommit(c, carriers);
    if (commit.resolved) return commit.value;
  }
  return null;
}

/**
 * The two answerable arms that draw a line: `converged` and `behind`.
 *
 * ONE rendering path. Both arms carry a `chain` — converged's is the single row
 * for HEAD — so there is no second way to draw a row and no second copy of
 * "which carrier goes where" to disagree with the first.
 *
 * Before drawing, the chain is extended back to whatever carrier it cannot
 * reach, which the server genuinely cannot do for itself: only a browser knows
 * which bundle it is running. The result is one chain with every carrier on its
 * own row, so "how far behind" is read off the rail rather than asserted in a
 * sentence.
 *
 * Own component, so the extension hook runs with a real carrier set and the
 * pending arm above it does not have to invent one.
 */
function ChainArm({
  state,
  carriers,
  served,
}: {
  state: Extract<DeploymentState, { kind: "converged" | "behind" }>;
  carriers: Carrier[];
  served: string | null;
}) {
  // Where each carrier's chip goes — for a tab running the served bytes, the
  // served bundle's commit rather than its own older build commit.
  const at = (c: Carrier) => placementCommit(c, carriers);
  const reachesTarget = (c: Carrier) => {
    const commit = at(c);
    return commit.resolved && sameCommit(commit.value, state.target);
  };
  const offServerChain = carriers.filter(
    (c) => rowOf(state.chain.commits, at(c)) < 0,
  );
  const reading = useChainFrom(extensionBase(offServerChain, carriers));

  // The extension is a superset of the server's chain — it walks from further
  // back to the same target — so it REPLACES rather than merges.
  const chain: Chain = reading.kind === "chain" ? reading.chain : state.chain;
  const rows = chain.commits;

  // Each carrier lands on the row of the commit it is actually on. One that
  // lands nowhere even after the extension is NOT dropped — `OffChain` renders
  // it, with the reason it has no row.
  const placed = new Map<number, Carrier[]>();
  const elsewhere: Carrier[] = [];
  for (const c of carriers) {
    const idx = rowOf(rows, at(c));
    if (idx < 0) elsewhere.push(c);
    else placed.set(idx, [...(placed.get(idx) ?? []), c]);
  }

  // `behind` with no readable pin at all (a fresh checkout with no dist, or a
  // mixed boot on both carriers): `behind` still holds, but there was no commit
  // to draw a line from. Rendering the flat pins rather than an empty chain — an
  // empty chain is the one thing this must never look like, "nothing to deploy".
  if (rows.length === 0) {
    return (
      <Section summary="Nothing deployed yet" tone="primary">
        <PinList carriers={carriers} target={state.target} served={served} />
      </Section>
    );
  }

  // The band boundary: the newest row a DEPLOYABLE carrier sits on. Everything
  // above it is running nowhere; everything from it down is running in at least
  // one of the two. A tab never moves this line — a tab is not something a
  // build deploys.
  const deployedIndices = state.deployable
    .map((c) => rowOf(rows, c.commit))
    .filter((i) => i >= 0);
  const firstDeployed =
    deployedIndices.length > 0 ? Math.min(...deployedIndices) : -1;
  const toDeploy = firstDeployed >= 0 ? firstDeployed : rows.length;

  // A tab holding older bytes is the ordinary case on the converged arm — the
  // deployable carriers converged and nobody reloaded — so the verdict names
  // what is converged rather than claiming the whole app is. Asked of the
  // CARRIERS, not of whether anything fell off the chain: now that the chain
  // reaches back to the tab, a stale tab has a row like everything else, and a
  // verdict keyed on "nothing is off-chain" would call that "Up to date".
  const summary =
    state.kind === "converged"
      ? carriers.every(reachesTarget)
        ? "Up to date"
        : "Deployed"
      : `${toDeploy} ${toDeploy === 1 ? "commit" : "commits"} to deploy`;
  const tone = state.kind === "converged" ? "success" : "primary";

  return (
    <Section summary={summary} tone={tone}>
      {/* The chain is bounded by how far a checkout drifts between builds, but
          that is not a small number after a quiet week — so it scrolls in its
          own box instead of turning the popover into a wall. */}
      <Scroll axis="y" className="max-h-48">
        <ol>
          {rows.map((commit, idx) => (
            <CommitRowItem
              key={commit.sha}
              commit={commit}
              isFirst={idx === 0}
              isLast={idx === rows.length - 1}
              color={
                firstDeployed >= 0 && idx >= firstDeployed
                  ? DEPLOYED_COLOR
                  : TO_DEPLOY_COLOR
              }
              markers={carrierMarkers(
                placed.get(idx) ?? [],
                commit.sha,
                state.target,
                served,
                // Rows run newest first, so a carrier's own row index IS the
                // number of commits between it and HEAD.
                idx,
              )}
              actions={<OpenCommitConversation commit={commit} />}
            />
          ))}
        </ol>
        {/* A capped walk must say so INSIDE the list. A chain that simply stops
            reads as "this is all of it", which is the one thing it is not. */}
        {chain.truncated && (
          <Line className="gap-sm px-md py-sm">
            <Text as="span" variant="caption" tone="muted">
              …and older commits below — the chain stops at {CHAIN_CAP}.
            </Text>
          </Line>
        )}
      </Scroll>
      <OffChain
        carriers={elsewhere}
        reading={reading}
        truncated={chain.truncated}
      />
    </Section>
  );
}

/**
 * What is deployed, as one chain of commits with a chip per carrier on the
 * commit it is actually on.
 *
 * Four arms, one per arm of the payload's own discriminated union — the arm is
 * NOT re-derived here. Each renders the evidence its arm genuinely carries, and
 * nothing it does not: `diverged` draws no line because there is none, and
 * `unknown` shows the pins plus the reason rather than an empty chain, which
 * would read as the one thing it does not mean ("nothing to deploy").
 *
 * Sized for the Build popover — global chrome, a few hundred pixels wide — so
 * the chain scrolls inside itself rather than growing the panel without bound.
 */
export function DeploymentChain() {
  return (
    // A dense readout of evidence, not a content surface: one declared density
    // for the whole section, and every leaf inside it — `Text` variants and the
    // carrier chips alike — steps down one type rung together through the single
    // density→text policy. Declared HERE rather than by each host, because a
    // fact-per-line chain reads the same way in the Build popover and in the
    // Build pane; and stated once, so no leaf can be left a rung behind.
    <ControlSizeProvider size="xs">
      <DeploymentChainBody />
    </ControlSizeProvider>
  );
}

function DeploymentChainBody() {
  const reading = useDeployment();

  if (reading.status === "loading") return <Loading variant="rows" count={2} />;
  if (reading.status === "unavailable")
    return <Placeholder>{reading.message}</Placeholder>;
  if (reading.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the deployment"
        error={reading.error}
        refetch={reading.refetch}
      />
    );
  }

  const { state, carriers } = reading.data;
  const served = servedGraph(carriers);

  if (state.kind === "unknown") {
    return (
      <Section summary="No checkout" tone="muted">
        <Placeholder>
          {state.reason} — so there is no commit to converge toward. The pins
          below are still facts.
        </Placeholder>
        <PinList carriers={carriers} target={null} served={served} />
      </Section>
    );
  }

  if (state.kind === "diverged") {
    return (
      <Section summary="App diverged" tone="destructive">
        <Placeholder>
          A carrier is on a commit that is not on the way to{" "}
          <span className="font-mono">{short(state.target)}</span> — the
          checkout was rebased or force-pushed under the running app. There is
          no line to draw, so here are the raw pins.
        </Placeholder>
        <PinList carriers={carriers} target={state.target} served={served} />
      </Section>
    );
  }

  return <ChainArm state={state} carriers={carriers} served={served} />;
}
