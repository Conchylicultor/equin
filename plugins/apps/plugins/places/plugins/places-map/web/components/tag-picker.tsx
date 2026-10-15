import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { useMemo, useState } from "react";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  flattenTagTree,
  isRoleTag,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import { TagMark } from "@plugins/apps/plugins/places/plugins/tag-manager/web";
import { tagPathLabel } from "./tag-chip";

const addIcon = symbol("add");

/** One tree level's indent inside the picker, in px. */
const INDENT_PX = 12;

/**
 * "+ Tag" on the place card: a dashed button opening the tag tree (Been /
 * Want to go left out — the card has its own toggles for them), with a search
 * that matches names and paths. Tags the place already has are not offered.
 */
export function TagPicker({
  tags,
  exclude,
  onPick,
}: {
  tags: readonly PlaceTag[];
  /** Tag ids already on the place. */
  exclude: readonly string[];
  onPick: (tagId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const entries = useMemo(
    () =>
      flattenTagTree(tags).filter(
        ({ tag }) => !isRoleTag(tag.id, tags) && !exclude.includes(tag.id),
      ),
    [tags, exclude],
  );
  const q = query.trim().toLowerCase();
  const shown =
    q === ""
      ? entries
      : entries.filter(({ tag }) =>
          tagPathLabel(tag.id, tags).toLowerCase().includes(q),
        );
  return (
    <ControlPanelPopover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      size="menu"
      maxHeight="lg"
      align="start"
      label="Add a tag"
      trigger={
        <Button variant="dashed">
          <Icon icon={addIcon} />
          Tag
        </Button>
      }
    >
      <ControlPanel.Section>
        <SearchInput
          appearance="menu"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a tag…"
          aria-label="Find a tag"
        />
      </ControlPanel.Section>
      <ControlPanel.Section>
        {shown.length === 0 ? (
          <ControlPanel.Empty>No tag to add.</ControlPanel.Empty>
        ) : null}
        {shown.map(({ tag, depth }) => (
          <ControlPanel.Row
            key={tag.id}
            icon={<TagMark tag={tag} tags={tags} />}
            hint={q === "" ? undefined : tagPathLabel(tag.id, tags)}
            onSelect={() => {
              setOpen(false);
              setQuery("");
              onPick(tag.id);
            }}
          >
            <span style={{ paddingLeft: q === "" ? depth * INDENT_PX : 0 }}>
              {tag.name}
            </span>
          </ControlPanel.Row>
        ))}
      </ControlPanel.Section>
    </ControlPanelPopover>
  );
}
