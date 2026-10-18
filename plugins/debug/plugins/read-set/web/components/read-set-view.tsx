import { useMemo, useState, type ReactElement } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@plugins/primitives/plugins/collapsible/web";
import {
  resourcesDebug,
  type ResourceDebug,
  type ResourceFreshness,
} from "../../core";
import {
  computeCeiling,
  type Ceiling,
  type DriftEntry,
  type RelationReadEntry,
  type RoutedFullEntry,
} from "../internal/ceiling";

// Debug pane over the `resources.debug` snapshot value (the runtime's `_debug`
// payload, re-measured on mount and on Refresh). Everything below is derived
// purely client-side from the payload: `resources[].notifyStats`,
// `resources[].readSet` (the captured loader→table index the server records, in
// view / table / rollup space), `resources[].policy` (what the entry is:
// routed, external, unrouted or unbound — the runtime's own
// classification), and `resources[].routes` / `relationReads` / `routeDrifted` (an
// entry's plan — a routed entry's, or an external one's declared reads — and
// its drift guard's record). Three sections, in render order:
//   A — notify provenance: per-resource hand / feed / producer counts during
//       the L4 parallel run, flagging read-set-gap candidates (hand > 0 and no
//       feed or producer delivery).
//   B — the captured index, inverted to table → [resource keys] (raw read-set,
//       rollups included).
//   C — the read-set ceiling (A7, `computeCeiling` in `../internal/ceiling`):
//       per-policy counts; every declared `full` route and relation read
//       with its reason (external ones tagged); drift; the routed,
//       pure-external, unrouted and unbound keys.
//   D — declared freshness (`resources[].freshness`): every external value's
//       `changes` — notified, or immutable / fixed / snapshot with its reason.

interface TableEntry {
  table: string;
  readers: string[];
}

interface NotifyEntry {
  key: string;
  hand: number;
  feed: number;
  /** Deliveries from an in-process change producer (a produced table). */
  producer: number;
  /**
   * hand > 0 with no feed or producer delivery — no change source covers what
   * the hand-notify does.
   */
  gap: boolean;
}

/** Invert every resource's readSet into table → sorted unique reader keys. */
function buildCapturedIndex(resources: ResourceDebug[]): TableEntry[] {
  const byTable = new Map<string, Set<string>>();
  for (const r of resources) {
    for (const table of r.readSet) {
      let readers = byTable.get(table);
      if (!readers) {
        readers = new Set();
        byTable.set(table, readers);
      }
      readers.add(r.key);
    }
  }
  return [...byTable.entries()]
    .map(([table, readers]) => ({ table, readers: [...readers].sort() }))
    .sort((a, b) => a.table.localeCompare(b.table));
}

/**
 * Project each resource's notify provenance counters into a sorted list, with
 * gap candidates (hand > 0, no feed or producer delivery) first. Resources that
 * have never notified (every counter 0) are dropped — nothing to compare yet.
 */
function buildNotifyEntries(resources: ResourceDebug[]): NotifyEntry[] {
  return resources
    .map((r) => ({
      key: r.key,
      hand: r.notifyStats.hand,
      feed: r.notifyStats.feed,
      producer: r.notifyStats.producer,
      // A declared route or relation read IS a change source: a routed change
      // reaches only subscribed tuples, so `feed` stays 0 while nobody holds
      // one — that is not a gap.
      gap:
        !r.routes?.length &&
        r.relationReads.length === 0 &&
        r.notifyStats.hand > 0 &&
        r.notifyStats.feed === 0 &&
        r.notifyStats.producer === 0,
    }))
    .filter((e) => e.hand > 0 || e.feed > 0 || e.producer > 0)
    .sort((a, b) => {
      if (a.gap !== b.gap) return a.gap ? -1 : 1; // gaps first
      return a.key.localeCompare(b.key);
    });
}

interface FreshnessEntry {
  key: string;
  freshness: ResourceFreshness;
}

/** The order the freshness section lists its arms in: the never-told ones first. */
const FRESHNESS_ORDER: readonly ResourceFreshness["kind"][] = [
  "snapshot",
  "fixed",
  "immutable",
  "notified",
];

/** Every resource with a declared freshness, grouped by arm (see `FRESHNESS_ORDER`), then by key. */
function buildFreshnessEntries(resources: ResourceDebug[]): FreshnessEntry[] {
  const entries: FreshnessEntry[] = [];
  for (const r of resources) {
    if (r.freshness !== null)
      entries.push({ key: r.key, freshness: r.freshness });
  }
  return entries.sort(
    (a, b) =>
      FRESHNESS_ORDER.indexOf(a.freshness.kind) -
        FRESHNESS_ORDER.indexOf(b.freshness.kind) || a.key.localeCompare(b.key),
  );
}

export function ReadSetView(): ReactElement {
  // A snapshot: measured when read, never pushed — a resource the pane
  // subscribes to would perturb what it measures. Refresh re-measures.
  const result = useLive(resourcesDebug);

  if (result.status === "loading") {
    return (
      <Scroll className="h-full p-lg">
        <Loading variant="rows" />
      </Scroll>
    );
  }
  if (result.status === "error") {
    return (
      <Scroll className="h-full p-lg">
        <ResourceErrorInline
          variant="block"
          subject="the resource registry"
          error={result.error}
          refetch={result.refetch}
        />
      </Scroll>
    );
  }
  return (
    <ReadSetBody resources={result.data.resources} refresh={result.refresh} />
  );
}

function ReadSetBody({
  resources,
  refresh,
}: {
  resources: ResourceDebug[];
  refresh: () => Promise<void>;
}): ReactElement {
  const captured = useMemo(() => buildCapturedIndex(resources), [resources]);
  const ceiling = useMemo(() => computeCeiling(resources), [resources]);
  const notifyEntries = useMemo(
    () => buildNotifyEntries(resources),
    [resources],
  );
  const freshnessEntries = useMemo(
    () => buildFreshnessEntries(resources),
    [resources],
  );

  return (
    <Scroll className="h-full p-lg">
      <Stack gap="xl">
        <Stack gap="sm">
          <Stack direction="row" gap="none" justify="end">
            <Button variant="outline" onClick={() => refresh()}>
              Refresh
            </Button>
          </Stack>
          <Caveat />
        </Stack>
        <NotifyProvenanceSection entries={notifyEntries} />
        <CapturedIndexSection entries={captured} />
        <CeilingSection ceiling={ceiling} />
        <FreshnessSection entries={freshnessEntries} />
      </Stack>
    </Scroll>
  );
}

function Caveat(): ReactElement {
  return (
    <Placeholder tone="muted">
      Read-sets and drift cover only loaders that have run since boot (or, for
      drift, were seeded from a persisted row), so the drift list is a lower
      bound. Direct notify() sites are not modeled.
    </Placeholder>
  );
}

// ── Section B: captured table → [resources] index ──────────────────────────

function CapturedIndexSection({
  entries,
}: {
  entries: TableEntry[];
}): ReactElement {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter(
      (e) =>
        e.table.toLowerCase().includes(needle) ||
        e.readers.some((r) => r.toLowerCase().includes(needle)),
    );
  }, [entries, query]);

  return (
    <Stack as="section" gap="sm">
      <SectionLabel>
        Captured index{" "}
        <span className="opacity-60">{entries.length} tables</span>
      </SectionLabel>
      <SearchInput
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter by table or resource…"
      />
      {entries.length === 0 ? (
        <Text variant="caption" tone="muted">
          No tables captured yet — browse to run loaders.
        </Text>
      ) : (
        <Stack gap="sm">
          {filtered.map((e) => (
            <ChipRow
              key={e.table}
              label={e.table}
              aside={e.readers.length}
              chips={e.readers.map((r) => ({ key: r, text: r }))}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

/**
 * One labeled row: a mono identity on the left, a count on the right, and a
 * wrapping Cluster of identity chips below. Shared by Sections B and C so a long
 * chip list wraps (Cluster) rather than truncating in a single-line slot.
 */
function ChipRow({
  label,
  tag,
  aside,
  chips,
  variant,
  empty,
}: {
  label: string;
  /** A short badge beside the label (e.g. the entry's policy when it is not the section's own). */
  tag?: string;
  /** Right-aligned meta: a count, or a short summary. */
  aside: string | number;
  chips: { key: string; text: string }[];
  variant?: "warning";
  /** Shown in place of the chips when there are none. */
  empty?: string;
}): ReactElement {
  return (
    <Stack gap="2xs">
      <Stack direction="row" gap="sm" align="baseline" justify="between">
        <Cluster gap="2xs">
          <Text variant="caption" className="font-mono">
            {label}
          </Text>
          {tag !== undefined ? (
            <Badge variant="muted" mono>
              {tag}
            </Badge>
          ) : null}
        </Cluster>
        <Text as="span" variant="caption" tone="muted" className="tabular-nums">
          {aside}
        </Text>
      </Stack>
      {chips.length === 0 && empty !== undefined ? (
        <Text variant="caption" tone="muted">
          {empty}
        </Text>
      ) : (
        <Cluster gap="2xs">
          {chips.map((c) => (
            <Badge key={c.key} variant={variant} mono>
              {c.text}
            </Badge>
          ))}
        </Cluster>
      )}
    </Stack>
  );
}

// ── Section A: notify provenance (hand / feed / producer, L4 parallel run) ──

function NotifyProvenanceSection({
  entries,
}: {
  entries: NotifyEntry[];
}): ReactElement {
  const gaps = useMemo(() => entries.filter((e) => e.gap).length, [entries]);

  return (
    <Stack as="section" gap="sm">
      <SectionLabel>
        Notify provenance — hand / feed / producer{" "}
        <span className="opacity-60">
          {entries.length} active{gaps > 0 ? ` · ${gaps} gap` : ""}
        </span>
      </SectionLabel>
      {entries.length === 0 ? (
        <Text variant="caption" tone="muted">
          No notifies recorded yet — exercise a mutation to populate counts.
        </Text>
      ) : (
        <Stack gap="2xs">
          {entries.map((e) => (
            <NotifyRow key={e.key} entry={e} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

/**
 * One resource row: mono key on the left, hand / feed / producer count badges
 * on the right, with a destructive "read-set gap" flag when no change source
 * ever covered a table the hand-notify did.
 */
function NotifyRow({ entry }: { entry: NotifyEntry }): ReactElement {
  return (
    <Stack direction="row" gap="sm" align="baseline" justify="between">
      <Text variant="caption" className="font-mono">
        {entry.key}
      </Text>
      <Cluster gap="2xs">
        {entry.gap ? <Badge variant="destructive">read-set gap</Badge> : null}
        <Badge variant={entry.gap ? "warning" : "muted"} mono>
          hand {entry.hand}
        </Badge>
        <Badge variant={entry.feed > 0 ? "success" : "muted"} mono>
          feed {entry.feed}
        </Badge>
        <Badge variant={entry.producer > 0 ? "success" : "muted"} mono>
          producer {entry.producer}
        </Badge>
      </Cluster>
    </Stack>
  );
}

// ── Section C: read-set ceiling — what a change costs each entry ───────────

const POLICY_ORDER = ["routed", "external", "unrouted", "unbound"] as const;

function CeilingSection({ ceiling }: { ceiling: Ceiling }): ReactElement {
  return (
    <Stack as="section" gap="lg">
      <Stack gap="sm">
        <SectionLabel>Read-set ceiling — change reach by policy</SectionLabel>
        <Cluster gap="2xs">
          {POLICY_ORDER.map((p) => (
            <Badge key={p} variant="muted" mono>
              {p} {ceiling.keys[p].length}
            </Badge>
          ))}
        </Cluster>
      </Stack>
      <RoutedFullSection entries={ceiling.routedFull} />
      <RelationReadsSection entries={ceiling.relationReads} />
      <DriftSection entries={ceiling.drift} />
      <KeyListSection
        title="Routed — reached only through their routes"
        keys={ceiling.keys.routed}
        empty="No routed resources."
        collapsed
      />
      <KeyListSection
        title="External — reached only by their own notify()"
        keys={ceiling.pureExternal}
        empty="No external resource without a declared read or drift."
      />
      <KeyListSection
        title="Unrouted — DB-backed, reached by no change (refused at boot)"
        keys={ceiling.keys.unrouted}
        empty="Every DB-backed resource declares its reads."
      />
      <KeyListSection
        title="Unbound — deferred, not bound yet"
        keys={ceiling.keys.unbound}
        empty="Every deferred resource is bound."
      />
    </Stack>
  );
}

/**
 * Every declared `full` route with its reason — a routed entry's, or an
 * external one's declared reads (tagged) — so a routed FULL is never silent.
 */
function RoutedFullSection({
  entries,
}: {
  entries: RoutedFullEntry[];
}): ReactElement {
  return (
    <Stack gap="sm">
      <SectionLabel>
        Routed FULL — declared full routes{" "}
        <span className="opacity-60">{entries.length}</span>
      </SectionLabel>
      {entries.length === 0 ? (
        <Text variant="caption" tone="muted">
          No resource declares a full route.
        </Text>
      ) : (
        <Stack gap="2xs">
          {entries.map((e) => (
            <Stack
              key={`${e.key} ${e.route}`}
              direction="row"
              gap="sm"
              align="baseline"
              justify="between"
            >
              <Cluster gap="2xs">
                <Text variant="caption" className="font-mono">
                  {`${e.key} ← ${e.table}`}
                </Text>
                {e.policy === "routed" ? null : (
                  <Badge variant="muted" mono>
                    {e.policy}
                  </Badge>
                )}
              </Cluster>
              <Text as="span" variant="caption" tone="muted">
                {e.reason}
              </Text>
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

/**
 * Every view (or rollup) a plan reads whole, with its relation bases: a write
 * to any base recomputes the entry FULL, for the declared reason.
 */
function RelationReadsSection({
  entries,
}: {
  entries: RelationReadEntry[];
}): ReactElement {
  return (
    <Stack gap="sm">
      <SectionLabel>
        Relation reads — views reached through their bases{" "}
        <span className="opacity-60">{entries.length}</span>
      </SectionLabel>
      {entries.length === 0 ? (
        <Text variant="caption" tone="muted">
          No resource declares a view read.
        </Text>
      ) : (
        <Stack gap="sm">
          {entries.map((e) => (
            <ChipRow
              key={`${e.key} ${e.relation}`}
              label={`${e.key} ← ${e.relation}`}
              tag={e.policy === "routed" ? undefined : e.policy}
              aside={e.reason}
              chips={e.bases.map((t) => ({ key: t, text: t }))}
              empty="No bases known yet — the relation bases are injected at boot."
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

/**
 * Drift, as the runtime's guard recorded it (A8 for a routed entry, D5 for a
 * notified external one): tables a loader read that its plan does not cover —
 * each now recomputes the entry FULL, until a restart re-seeds it.
 */
function DriftSection({ entries }: { entries: DriftEntry[] }): ReactElement {
  return (
    <Stack gap="sm">
      <SectionLabel>
        Route drift — read but never declared{" "}
        <span className="opacity-60">{entries.length}</span>
      </SectionLabel>
      {entries.length === 0 ? (
        <Text variant="caption" tone="muted">
          No drift — every guarded resource reads only what its plan declares.
        </Text>
      ) : (
        <Stack gap="sm">
          {entries.map((d) => (
            <ChipRow
              key={d.key}
              label={d.key}
              tag={d.policy === "routed" ? undefined : d.policy}
              aside={d.tables.length}
              variant="warning"
              chips={d.tables.map((t) => ({ key: t, text: t }))}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function KeyListSection({
  title,
  keys,
  empty,
  collapsed,
}: {
  title: string;
  keys: string[];
  empty: string;
  /** Start folded behind its title (a long list that is not a cost). */
  collapsed?: boolean;
}): ReactElement {
  const label = (as: "div" | "span") => (
    <SectionLabel as={as}>
      {title} <span className="opacity-60">{keys.length}</span>
    </SectionLabel>
  );
  const body =
    keys.length === 0 ? (
      <Text variant="caption" tone="muted">
        {empty}
      </Text>
    ) : (
      <Cluster gap="2xs">
        {keys.map((k) => (
          <Badge key={k} mono>
            {k}
          </Badge>
        ))}
      </Cluster>
    );
  if (collapsed) {
    return (
      <Collapsible defaultOpen={false}>
        <Stack gap="sm">
          <CollapsibleTrigger className="gap-xs">
            <CollapsibleChevron className="size-3 text-muted-foreground" />
            {label("span")}
          </CollapsibleTrigger>
          <CollapsibleContent>{body}</CollapsibleContent>
        </Stack>
      </Collapsible>
    );
  }
  return (
    <Stack gap="sm">
      {label("div")}
      {body}
    </Stack>
  );
}

// ── Section D: declared freshness (external values' `changes`) ─────────────

/**
 * Every external value's declared `changes`: the arm as a badge, and — for a
 * value that is never told of a change — the author's reason why that is
 * honest.
 */
function FreshnessSection({
  entries,
}: {
  entries: FreshnessEntry[];
}): ReactElement {
  return (
    <Stack as="section" gap="sm">
      <SectionLabel>
        Declared freshness — external values{" "}
        <span className="opacity-60">{entries.length}</span>
      </SectionLabel>
      {entries.length === 0 ? (
        <Text variant="caption" tone="muted">
          No external value declares its freshness.
        </Text>
      ) : (
        <Stack gap="2xs">
          {entries.map((e) => (
            <Stack
              key={e.key}
              direction="row"
              gap="sm"
              align="baseline"
              justify="between"
            >
              <Cluster gap="2xs">
                <Text variant="caption" className="font-mono">
                  {e.key}
                </Text>
                <Badge variant="muted" mono>
                  {e.freshness.kind}
                </Badge>
              </Cluster>
              {e.freshness.reason !== undefined ? (
                <Text as="span" variant="caption" tone="muted">
                  {e.freshness.reason}
                </Text>
              ) : null}
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
