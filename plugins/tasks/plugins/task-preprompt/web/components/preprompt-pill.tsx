import { PickerPill } from "@plugins/primitives/plugins/text-editor/plugins/composer/plugins/picker-pill/web";
import {
  PrepromptGlyph,
  useEditPrepromptLibrary,
  usePrepromptItems,
} from "@plugins/conversations/plugins/preprompts/web";
import { SnippetEditor } from "@plugins/conversations/plugins/prompt-snippets/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import type { LaunchControlProps } from "@plugins/tasks/plugins/launch-options/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const editIcon = symbol("edit");
const addIcon = symbol("add");

/**
 * The chosen preprompt's title as the pill's text. Never rendered for `None`.
 *
 * A stored id whose preprompt has since been deleted renders nothing, so the
 * pill falls back to its placeholder — the same collapse-to-None the select in
 * the task detail does.
 */
export function PrepromptPillValue({ value }: { value: string }) {
  const items = usePrepromptItems();
  const item = items.find((p) => p.value === value);
  return <>{item?.label}</>;
}

/**
 * The menu rows: `None`, then every preprompt in the library, each keeping its
 * own marker glyph, then + New preprompt.
 *
 * The library is edited from here, in place — the same snippet editor the
 * prompt templates panel uses: ✎ on a row rewrites (or deletes) that
 * preprompt (unpicking it if it was picked), + New preprompt adds one and
 * selects it. While an editor is open it is the whole group, so no row's
 * hover can take focus from what is typed.
 */
export function PrepromptPillMenu({
  value,
  onChange,
  disabled,
}: LaunchControlProps<string | null>) {
  const items = usePrepromptItems();
  const library = useEditPrepromptLibrary({
    onAdded: disabled ? undefined : onChange,
    // Deleting the picked preprompt unpicks it, rather than leaving the task
    // naming one that is gone.
    onRemoved: (id) => {
      if (!disabled && id === value) onChange(null);
    },
  });

  if (library.editor) {
    return (
      <Stack gap="none" className="w-72 px-xs">
        <SnippetEditor
          key={library.editor.key}
          {...library.editor.props}
          noun="Preprompt"
        />
      </Stack>
    );
  }

  return (
    <>
      <PickerPill.Item
        selected={value == null}
        onSelect={() => onChange(null)}
        disabled={disabled}
      >
        None
      </PickerPill.Item>
      {items.map((item) => (
        <PickerPill.Item
          key={item.value}
          icon={
            <PrepromptGlyph
              icon={item.icon}
              className="text-muted-foreground"
            />
          }
          selected={value === item.value}
          onSelect={() => onChange(item.value)}
          disabled={disabled}
          action={{
            icon: editIcon,
            label: `Edit: ${item.label}`,
            onAction: () => library.startEdit(item.value),
          }}
        >
          {item.label}
        </PickerPill.Item>
      ))}
      <PickerPill.Item
        keepOpen
        icon={
          <Icon icon={addIcon} className="size-3.5 text-muted-foreground" />
        }
        onSelect={() => library.startNew()}
      >
        New preprompt
      </PickerPill.Item>
    </>
  );
}
