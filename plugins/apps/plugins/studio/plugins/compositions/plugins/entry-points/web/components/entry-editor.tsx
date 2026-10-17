import { useState } from "react";
import {
  Button,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { updateActiveDraft } from "@plugins/plugin-meta/plugins/composition/web";
import {
  parseEntryPattern,
  type CompositionManifest,
  type EntryPattern,
} from "@plugins/plugin-meta/plugins/closure/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");
const closeIcon = symbol("close");

// Compact chip label for an entry pattern: the base's last segment, decorated
// with the grammar markers so `apps.website.demos`, `apps.website.demos.**`, and
// `!apps.website.demos.**` stay visually distinct. (The full pattern editor is a
// deferred increment; this keeps the current chips honest.)
function shortName(pattern: EntryPattern): string {
  const p = parseEntryPattern(pattern);
  // The root `**` has no base to shorten — it means every plugin, so it is its own
  // label. The add control below only ever authors bare ids, so `**` reaches this
  // chip from a hand-written manifest, never from the picker.
  if (p.kind === "root") return `${p.negate ? "!" : ""}**`;
  const s = String(p.base);
  const dot = s.lastIndexOf(".");
  const leaf = dot === -1 ? s : s.slice(dot + 1);
  return `${p.negate ? "!" : ""}${leaf}${p.subtree ? ".**" : ""}`;
}

/**
 * Secondary editor for the draft's entry points. Lists current entries with a
 * remove affordance and an add control (search over every known plugin id).
 * Each edit patches the draft via `updateActiveDraft`, re-resolving membership.
 *
 * With `editable={false}` the same list renders READ-ONLY — the chips keep their
 * shape and lose their remove button, Add is inert with a title saying why, and
 * a note names the file that does own the list. That is the two committed-source
 * rows (main's and `base-exclusions`): what they contain is emitted into the
 * registries by codegen, off the committed config, so a stored edit would look
 * like a change and mean nothing. Rendered inert rather than absent, because
 * reading those entry points is exactly why someone opens this row.
 */
export function EntryEditor({
  draft,
  allIds,
  editable,
}: {
  draft: CompositionManifest;
  allIds: PluginId[];
  editable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = new Set<EntryPattern>(draft.entryPoints);

  function remove(pattern: EntryPattern): void {
    updateActiveDraft({
      entryPoints: draft.entryPoints.filter((x) => x !== pattern),
    });
  }
  function add(id: PluginId): void {
    if (current.has(id)) return;
    updateActiveDraft({ entryPoints: [...draft.entryPoints, id] });
    setOpen(false);
    setQuery("");
  }

  const q = query.trim().toLowerCase();
  const candidates = allIds
    .filter(
      (id) => !current.has(id) && (!q || String(id).toLowerCase().includes(q)),
    )
    .slice(0, 50);

  return (
    <Stack gap="sm">
      <Stack direction="row" align="center" justify="between" gap="sm">
        <SectionLabel>Entry points</SectionLabel>
        <InlinePopover
          resetOnClose
          open={open}
          onOpenChange={setOpen}
          align="end"
          width="xl"
          trigger={
            <Button
              variant="outline"
              disabled={!editable}
              tooltip={
                editable
                  ? undefined
                  : "This composition's entry points are committed source — edit core/config.ts and rebuild."
              }
            >
              <Icon icon={addIcon} />
              Add
            </Button>
          }
        >
          <Stack gap="sm">
            <SearchInput
              appearance="menu"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search plugins…"
              autoFocus
            />
            <Scroll axis="y" className="max-h-64">
              <Stack gap="2xs">
                {candidates.length === 0 ? (
                  <Text variant="caption" tone="muted">
                    No matching plugins.
                  </Text>
                ) : (
                  // eslint-disable-next-line data-view/no-adhoc-row-list -- add-item search popover (transient chrome)
                  candidates.map((id) => (
                    <Row
                      key={id}
                      size="sm"
                      onClick={() => add(id)}
                      title={String(id)}
                    >
                      <span className="truncate font-mono">{String(id)}</span>
                    </Row>
                  ))
                )}
              </Stack>
            </Scroll>
          </Stack>
        </InlinePopover>
      </Stack>
      {draft.entryPoints.length === 0 ? (
        <Text variant="caption" tone="muted">
          No entry points.
        </Text>
      ) : (
        <Cluster gap="xs">
          {draft.entryPoints.map((pattern) => (
            <Badge
              key={pattern}
              variant="primary"
              tooltip={String(pattern)}
              icon={
                editable ? (
                  <ControlSizeProvider size="sm">
                    <IconButton
                      icon={closeIcon}
                      label="Remove entry point"
                      onClick={() => remove(pattern)}
                    />
                  </ControlSizeProvider>
                ) : undefined
              }
            >
              <span className="font-mono">{shortName(pattern)}</span>
            </Badge>
          ))}
        </Cluster>
      )}
      {!editable && (
        <Text as="p" variant="caption" tone="muted">
          These entry points decide what the app ships, so they live in{" "}
          <code>plugins/plugin-meta/plugins/composition/core/config.ts</code>{" "}
          and change with a build. An edit stored here would never reach a
          generated registry — codegen reads the committed config, not this one.
        </Text>
      )}
    </Stack>
  );
}
