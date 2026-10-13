import { useState, type ReactElement } from "react";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import {
  Button,
  ControlSizeProvider,
  Input,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { localUndoProps } from "@plugins/primitives/plugins/undo-redo/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  TAG_COLORS,
  TagNameSchema,
  tagKey,
  type PageTagRow,
  type TagColor,
} from "../../core";
import {
  createPageTag,
  deletePageTag,
  updatePageTag,
} from "../../shared/endpoints";
import type { PageTagsEditor } from "../internal/hooks";
import { TagDot, tagHue } from "./tag-chip";

const checkIcon = symbol("check");
const moreIcon = symbol("more-horiz");
const addIcon = symbol("add");

export interface TagPickerProps {
  /** The page's tags and the vocabulary, editable (`usePageTagsEditor`). */
  editor: PageTagsEditor;
  /** What opens the picker; the panel anchors to it. */
  trigger: ReactElement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The tag picker: one field that searches the workspace vocabulary and, when
 * nothing matches, offers to create what was typed (Enter does the same). Each
 * vocabulary row toggles the tag on the page, and its hover `⋯` unfolds in
 * place into the tag's own settings — rename, color, delete — which apply to
 * every page carrying it.
 *
 * Creating is a deliberate second step ("Create “…”"), never a side effect of
 * typing a near-miss: the same guard the agent surface applies with its
 * explicit `new` attribute, so the vocabulary does not drift into spellings.
 */
export function TagPicker({
  editor,
  trigger,
  open,
  onOpenChange,
}: TagPickerProps) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const create = useEndpointMutation(createPageTag);

  const { assigned, vocabulary, setTagIds } = editor;
  const assignedIds = assigned.map((t) => t.id);
  const key = tagKey(query);
  const matches =
    key === ""
      ? vocabulary
      : vocabulary.filter((t) => tagKey(t.name).includes(key));
  const exact = vocabulary.find((t) => tagKey(t.name) === key);
  const parsedName = TagNameSchema.safeParse(query);

  const toggle = (tag: PageTagRow) => {
    setTagIds(
      assignedIds.includes(tag.id)
        ? assignedIds.filter((id) => id !== tag.id)
        : [...assignedIds, tag.id],
    );
  };

  const createAndAssign = async () => {
    if (!parsedName.success) return;
    const { id } = await create.mutateAsync({
      body: { name: parsedName.data },
    });
    setTagIds([...assignedIds, id]);
    setQuery("");
  };

  const onEnter = () => {
    if (exact) {
      toggle(exact);
      setQuery("");
    } else if (key !== "") {
      void createAndAssign();
    }
  };

  return (
    <InlinePopover
      trigger={trigger}
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setEditing(null);
      }}
      width="md"
      padding="xs"
    >
      <Stack gap="xs">
        <SearchInput
          appearance="menu"
          // Declared, not inherited: the panel portals out of the page body, so
          // its undo owner is this field's own (see page-link's picker).
          {...localUndoProps}
          autoFocus
          placeholder="Search or create a tag…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onEnter();
            }
          }}
        />
        <Inline gap="none" className="px-sm pt-2xs">
          <Text variant="caption" tone="faint">
            Workspace tags
          </Text>
        </Inline>
        <Scroll className="max-h-72">
          <Stack gap="none">
            {matches.map((tag) =>
              editing === tag.id ? (
                <TagSettings
                  key={tag.id}
                  tag={tag}
                  vocabulary={vocabulary}
                  onDone={() => setEditing(null)}
                />
              ) : (
                <TagOption
                  key={tag.id}
                  tag={tag}
                  checked={assignedIds.includes(tag.id)}
                  onToggle={() => toggle(tag)}
                  onEdit={() => setEditing(tag.id)}
                />
              ),
            )}
            {key !== "" && !exact && (
              <Row
                hover="muted"
                disabled={!parsedName.success || create.isPending}
                onClick={() => void createAndAssign()}
                title={
                  parsedName.success
                    ? undefined
                    : parsedName.error.issues[0]?.message
                }
                icon={
                  <Center as="span" className="size-4 text-muted-foreground">
                    <Icon icon={addIcon} className="size-4" />
                  </Center>
                }
              >
                <Text>{`Create “${query.trim()}”`}</Text>
              </Row>
            )}
            {key === "" && vocabulary.length === 0 && (
              <Inline gap="none" className="px-sm py-xs">
                <Text variant="caption" tone="muted">
                  No tags yet — type a name to create one.
                </Text>
              </Inline>
            )}
          </Stack>
        </Scroll>
      </Stack>
    </InlinePopover>
  );
}

/** One vocabulary row: the tag's hue and name, a check while assigned, `⋯` on hover. */
function TagOption({
  tag,
  checked,
  onToggle,
  onEdit,
}: {
  tag: PageTagRow;
  checked: boolean;
  onToggle: () => void;
  onEdit: () => void;
}) {
  return (
    <Row
      hover="muted"
      onClick={onToggle}
      aria-pressed={checked}
      icon={
        <Center as="span" className="size-4">
          <TagDot color={tag.color} />
        </Center>
      }
      actions={
        <IconButton
          icon={moreIcon}
          label={`Edit “${tag.name}”`}
          variant="ghost"
          onClick={onEdit}
        />
      }
    >
      <Fill>
        <Text>{tag.name}</Text>
      </Fill>
      {checked && (
        <Icon icon={checkIcon} className="size-4 text-muted-foreground" />
      )}
    </Row>
  );
}

/**
 * A tag's own settings, unfolded in place of its row: the name (saved on Enter
 * or when the field loses focus), the palette, and Delete — which asks once
 * more, since it takes the tag off every page carrying it.
 */
function TagSettings({
  tag,
  vocabulary,
  onDone,
}: {
  tag: PageTagRow;
  vocabulary: readonly PageTagRow[];
  onDone: () => void;
}) {
  const [name, setName] = useState(tag.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const update = useEndpointMutation(updatePageTag);
  const remove = useEndpointMutation(deletePageTag);

  const parsed = TagNameSchema.safeParse(name);
  const taken =
    parsed.success &&
    vocabulary.some(
      (t) => t.id !== tag.id && tagKey(t.name) === tagKey(parsed.data),
    );
  const nameError = !parsed.success
    ? parsed.error.issues[0]?.message
    : taken
      ? "another tag already has this name"
      : undefined;

  const saveName = async () => {
    if (!parsed.success || taken || parsed.data === tag.name) return;
    await update.mutateAsync({
      params: { tagId: tag.id },
      body: { name: parsed.data },
    });
  };

  const setColor = (color: TagColor) => {
    if (color === tag.color) return;
    update.mutate({ params: { tagId: tag.id }, body: { color } });
  };

  return (
    <Stack gap="xs" className="rounded-md bg-muted/60 p-xs">
      <Input
        {...localUndoProps}
        autoFocus
        aria-label="Tag name"
        aria-invalid={nameError !== undefined}
        title={nameError}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => void saveName()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void saveName().then(onDone);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onDone();
          }
        }}
      />
      <Inline gap="2xs" role="radiogroup" aria-label="Tag color">
        {TAG_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={color === tag.color}
            aria-label={color}
            title={color}
            onClick={() => setColor(color)}
            className={cn(
              "size-5 rounded-full",
              color === tag.color &&
                "ring-2 ring-ring ring-offset-1 ring-offset-popover",
            )}
            // The swatch IS the palette token (a CSS var, never a hex).
            style={{ backgroundColor: tagHue(color) }}
          />
        ))}
      </Inline>
      <ControlSizeProvider size="xs">
        <Inline gap="xs">
          <Button
            variant="ghost"
            className={cn(
              "text-caption font-normal",
              confirmDelete ? "text-destructive" : "text-muted-foreground",
            )}
            disabled={remove.isPending}
            onClick={() => {
              if (!confirmDelete) {
                setConfirmDelete(true);
                return;
              }
              void remove
                .mutateAsync({ params: { tagId: tag.id } })
                .then(onDone);
            }}
          >
            {confirmDelete ? "Delete from every page?" : "Delete"}
          </Button>
          <Fill />
          <Button
            variant="ghost"
            className="text-caption font-normal text-muted-foreground"
            onClick={() => void saveName().then(onDone)}
          >
            Done
          </Button>
        </Inline>
      </ControlSizeProvider>
    </Stack>
  );
}
