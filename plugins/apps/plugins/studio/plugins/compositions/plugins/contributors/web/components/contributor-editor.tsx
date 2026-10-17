import { useMemo } from "react";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { SectionLabel, Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import {
  updateActiveDraft,
  useGraph,
} from "@plugins/plugin-meta/plugins/composition/web";
import {
  impactOfPruning,
  impactOfSelecting,
  type CompositionManifest,
  type Composition,
} from "@plugins/plugin-meta/plugins/closure/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";

function shortName(id: PluginId): string {
  const s = String(id);
  const dot = s.lastIndexOf(".");
  return dot === -1 ? s : s.slice(dot + 1);
}

/**
 * Live contributor selection over the active draft. The candidate set is the
 * resolved `available` frontier (reviewable options) plus the currently-selected
 * contributors (so they remain deselectable even once bundled). Each toggle
 * patches `selectedContributors` via `updateActiveDraft`, which re-resolves the
 * membership map client-side — the Explorer tint and detail sections update
 * instantly. The impact cost beside each chip is the engine's
 * `impactOfSelecting` (add) / `impactOfPruning` (drop) against the draft.
 */
export function ContributorEditor({
  draft,
  resolved,
  query,
  onQueryChange,
}: {
  draft: CompositionManifest;
  resolved: Composition;
  query: string;
  onQueryChange: (q: string) => void;
}) {
  const graph = useGraph();
  const selected = useMemo(
    () => new Set(draft.selectedContributors),
    [draft.selectedContributors],
  );

  // Candidate options: the available frontier ∪ current selections, deduped + sorted.
  const candidates = useMemo(() => {
    const set = new Set<PluginId>(resolved.available);
    for (const id of draft.selectedContributors) set.add(id);
    return [...set].sort();
  }, [resolved.available, draft.selectedContributors]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((id) => String(id).toLowerCase().includes(q));
  }, [candidates, query]);

  function toggle(id: PluginId): void {
    const next = selected.has(id)
      ? draft.selectedContributors.filter((x) => x !== id)
      : [...draft.selectedContributors, id];
    updateActiveDraft({ selectedContributors: next });
  }

  return (
    <Stack gap="sm">
      <Stack direction="row" align="center" justify="between" gap="sm">
        <SectionLabel>Contributors</SectionLabel>
        <Text variant="caption" tone="muted">
          {selected.size} selected · {candidates.length} options
        </Text>
      </Stack>
      <SearchInput
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Filter contributors…"
      />
      {!graph ? null : filtered.length === 0 ? (
        <Text variant="caption" tone="muted">
          No reviewable contributor options.
        </Text>
      ) : (
        <Stack gap="2xs">
          {filtered.map((id) => {
            const isOn = selected.has(id);
            const cost = isOn
              ? impactOfPruning(graph, draft, id)
              : impactOfSelecting(graph, draft, id);
            return (
              // Flexible chip cell + rigid impact meta. <Fill> owns the
              // grow/shrink role: it absorbs the slack (pushing the meta
              // flush-right) and, as a block box, lets the chip shrink-to-fit
              // and ellipsize. Its flex-basis:0 keeps the meta at content width.
              <Stack key={id} direction="row" align="center" gap="sm">
                <Fill>
                  <ToggleChip
                    variant="ghost"
                    active={isOn}
                    tooltip={String(id)}
                    onClick={() => toggle(id)}
                  >
                    <span className="truncate font-mono">{shortName(id)}</span>
                  </ToggleChip>
                </Fill>
                <Text variant="caption" tone="muted">
                  {isOn ? `−${cost.length} drop` : `+${cost.length} add`}
                </Text>
              </Stack>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
