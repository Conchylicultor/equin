import { useMemo, useState, type ReactElement } from "react";
import { useEndpoint } from "@plugins/infra/plugins/endpoints/web";
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
import { resourcesReadSetEndpoint } from "../../shared/endpoints";
import type { ResourceFreshness, ResourceReadSet } from "../../shared/schema";
import {
  computeCeiling,
  type Ceiling,
  type DriftEntry,
  type LegacyFullEntry,
  type RoutedFullEntry,
} from "../internal/ceiling";

// Web-only debug pane consuming `GET /api/resources/_debug`. Everything below is
// derived purely client-side from the payload: `resources[].notifyStats`,
// `resources[].readSet` (the captured loader→table index the server records, in
// view / table / rollup space), `resources[].policy` (what the entry is:
// routed, legacy-full, external or unbound — the runtime's own
// classification), `resources[].legacyReach` (the bases the runtime's legacy
// router indexes the entry under — external and unbound entries included —
// expanded through the relation bases: views transitively, rollups to their
// sources), and `resources[].routes` / `routeDrifted` (a routed entry's routes
// and the A8 drift guard's record). Three sections, in render order:
//   A — notify provenance: per-resource hand / feed / producer counts during
//       the L4 parallel run, flagging read-set-gap candidates (hand > 0 and no
//       feed or producer delivery).
//   B — the captured index, inverted to table → [resource keys] (raw read-set,
//       rollups included).
//   C — the read-set ceiling (A7, `computeCeiling` in `../internal/ceiling`):
//       per-policy counts; every entry the legacy router reaches with its
//       bases, FULL loads per base write and persistence (external ones
//       tagged); every routed `full` route with its reason; routed drift; the
//       routed, pure-external and unbound keys.
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
function buildCapturedIndex(resources: ResourceReadSet[]): TableEntry[] {
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
function buildNotifyEntries(resources: ResourceReadSet[]): NotifyEntry[] {
  return resources
    .map((r) => ({
      key: r.key,
      hand: r.notifyStats.hand,
      feed: r.notifyStats.feed,
      producer: r.notifyStats.producer,
      gap:
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
function buildFreshnessEntries(resources: ResourceReadSet[]): FreshnessEntry[] {
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
  /* eslint-disable polling-safety/no-refetch-interval -- inspects the live-state runtime itself; a resource of its own read set would perturb what it measures */
  const { data } = useEndpoint(
    resourcesReadSetEndpoint,
    {},
    { refetchInterval: 5000 },
  );
  /* eslint-enable polling-safety/no-refetch-interval */

  const resources = useMemo(() => data?.resources ?? [], [data]);
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

  if (!data) {
    return (
      <Scroll className="h-full p-lg">
        <Loading variant="rows" />
      </Scroll>
    );
  }

  return (
    <Scroll className="h-full p-lg">
      <Stack gap="xl">
        <Caveat />
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
      Read-sets cover only loaders that have run since boot (or were seeded from
      a persisted row): a legacy-full entry with no bases has not loaded yet, so
      the ceiling is a lower bound. Direct notify() sites are not modeled.
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

const POLICY_ORDER = ["routed", "legacy-full", "external", "unbound"] as const;

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
      <LegacyFullSection entries={ceiling.legacyFull} />
      <RoutedFullSection entries={ceiling.routedFull} />
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
        empty="No external resource without a captured DB read."
      />
      <KeyListSection
        title="Unbound — deferred, not bound yet"
        keys={ceiling.keys.unbound}
        empty="Every deferred resource is bound."
      />
    </Stack>
  );
}

/** "3 s", "4 min", "2 h" — a coarse age for a debug aside. */
function formatAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}

function costAside(e: LegacyFullEntry): string {
  const parts = [
    `${e.loadsPerWrite} load${e.loadsPerWrite === 1 ? "" : "s"}/write`,
    `${e.tuples} tuple${e.tuples === 1 ? "" : "s"}`,
  ];
  if (e.persisted) {
    parts.push(
      e.positionAgeMs === null
        ? "persisted"
        : `persisted · ${formatAge(e.positionAgeMs)} old`,
    );
  }
  return parts.join(" · ");
}

/**
 * Every entry the legacy router reaches, with its relation bases: a write to
 * ANY of them recomputes it FULL. An external (or unbound) entry is here when
 * its loader read the DB — the router reaches it beside its own notify().
 */
function LegacyFullSection({
  entries,
}: {
  entries: LegacyFullEntry[];
}): ReactElement {
  return (
    <Stack gap="sm">
      <SectionLabel>
        Legacy FULL — any base write recomputes every tuple{" "}
        <span className="opacity-60">{entries.length}</span>
      </SectionLabel>
      {entries.length === 0 ? (
        <Text variant="caption" tone="muted">
          Nothing is reached by the legacy router — every DB-backed resource is
          routed.
        </Text>
      ) : (
        <Stack gap="sm">
          {entries.map((e) => (
            <ChipRow
              key={e.key}
              label={e.key}
              tag={e.policy === "legacy-full" ? undefined : e.policy}
              aside={costAside(e)}
              chips={e.bases.map((t) => ({ key: t, text: t }))}
              empty="No reads captured yet — its loader has not run."
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

/** Every routed `full` route with its declared reason — a routed FULL is never silent. */
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
          No routed resource declares a full route.
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
              <Text variant="caption" className="font-mono">
                {`${e.key} ← ${e.table}`}
              </Text>
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
 * Routed drift (A8), as the runtime's guard recorded it: tables a routed
 * entry's loader read that no route names — writes to them never reach it.
 */
function DriftSection({ entries }: { entries: DriftEntry[] }): ReactElement {
  return (
    <Stack gap="sm">
      <SectionLabel>
        Route drift — read but never routed{" "}
        <span className="opacity-60">{entries.length}</span>
      </SectionLabel>
      {entries.length === 0 ? (
        <Text variant="caption" tone="muted">
          No drift — every routed resource reads only tables its routes name.
        </Text>
      ) : (
        <Stack gap="sm">
          {entries.map((d) => (
            <ChipRow
              key={d.key}
              label={d.key}
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
