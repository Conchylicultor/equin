import type { ReactElement } from "react";
import {
  Button,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { openPane } from "@plugins/primitives/plugins/pane/web";
import {
  compositionsPane,
  compositionDetailPane,
} from "@plugins/apps/plugins/studio/plugins/compositions/web";
import {
  useActiveComposition,
  useManifestActions,
  updateActiveDraft,
  clearActive,
} from "@plugins/plugin-meta/plugins/composition/web";
import { useDeleteComposition } from "@plugins/build/plugins/serve-composition/web";
import { isCommittedSourceComposition } from "@plugins/plugin-meta/plugins/composition/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const deleteIcon = symbol("delete");
const saveIcon = symbol("save");

/**
 * Persistence actions for the active draft: an inline editable name plus Save /
 * Delete / Clear. The pane's `:id` is the composition being edited, so Save is
 * always an in-place update.
 *
 * Delete is available for every composition except the two the repo itself owns
 * as committed source — main's row and `base-exclusions`. Those entries must
 * exist, so the button is simply absent there (the config edit underneath
 * throws on them). It removes the row AND what the composition is serving: the
 * same `useDeleteComposition` the list row's Delete calls, so the two paths
 * cannot drift. The button pends while the server says what is at stake, then a
 * confirm dialog names every address and database that will go; only once they
 * are actually reclaimed does the draft clear and the pane close.
 *
 * Save is inert for those same two rows. What they contain decides what the app
 * ships, and codegen emits the registries from the COMMITTED config — so a
 * stored edit here would sit in the user layer looking like a change and never
 * reach a generated file. Changing them is an edit to
 * `plugins/plugin-meta/plugins/composition/core/config.ts` plus a build; the
 * `save` call underneath throws if this button is ever reached.
 */
export function DraftActions({ id }: { id: string }): ReactElement {
  const draft = useActiveComposition();
  const { save } = useManifestActions();
  const { deleteComposition } = useDeleteComposition();
  // Null only for a root pane; `compositionDetailPane` always has ancestors, so
  // the fallback is there to make the expression total.
  const close =
    compositionDetailPane.useClose() ??
    (() => openPane(compositionsPane, {}, { mode: "root" }));

  // The seed effect populates the store one frame after mount; Loading's built-in
  // delay means that gap never flashes.
  if (!draft) return <Loading variant="text" />;

  // The same predicate the `save` guard and the read-only entry-point surface
  // read, so the disabled button and the throw beneath it cannot disagree about
  // which rows they mean.
  const committedSource = isCommittedSourceComposition(id);
  const canSave = draft.name.trim().length > 0 && !committedSource;
  // The draft's name is what the person is looking at while they edit; an unsaved
  // rename is still how they think of this composition, so it is what the delete
  // dialog names.
  const draftName = draft.name;

  // Returned to the Button so it auto-pends for the inventory read; the dialog
  // owns everything after that, and the draft is only cleared once the row is
  // genuinely gone (never on cancel, never on a failed reclaim).
  function onDelete(): Promise<void> {
    return deleteComposition({
      id,
      name: draftName,
      onDeleted: () => {
        clearActive();
        close();
      },
    });
  }

  return (
    <Stack gap="sm">
      <Input
        value={draft.name}
        onChange={(e) => updateActiveDraft({ name: e.target.value })}
        placeholder="Composition name"
        aria-label="Composition name"
        // Same reason Save is inert: a name typed here could never be stored,
        // and a field that accepts text it cannot keep is the control-that-
        // cannot-succeed shape one level down from the button.
        readOnly={committedSource}
        title={
          committedSource
            ? "This composition is committed source — edit core/config.ts and rebuild."
            : undefined
        }
      />
      <Stack direction="row" align="center" gap="xs">
        <Button
          variant="default"
          disabled={!canSave}
          tooltip={
            committedSource
              ? "This composition is committed source — edit core/config.ts and rebuild."
              : undefined
          }
          onClick={() => save(draft, id)}
        >
          <Icon icon={saveIcon} />
          Save
        </Button>
        {!committedSource && (
          <Button variant="ghost" onClick={onDelete}>
            <Icon icon={deleteIcon} />
            Delete
          </Button>
        )}
        <Button variant="ghost" onClick={() => clearActive()}>
          Clear
        </Button>
      </Stack>
    </Stack>
  );
}
