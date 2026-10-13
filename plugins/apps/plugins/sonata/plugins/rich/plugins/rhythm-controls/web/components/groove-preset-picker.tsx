import { useState } from "react";
import {
  Button,
  cn,
  Input,
  SingleLineProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  SortableItem,
  SortableList,
} from "@plugins/primitives/plugins/sortable-list/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  grooveEquals,
  grooveSummary,
  presetGroove,
  type GrooveFields,
} from "../../shared/groove";
import {
  seedGroovePreset,
  type GroovePreset,
} from "../../shared/groove-presets";
import {
  useGroovePresets,
  type GroovePresetsController,
} from "../use-groove-presets";
import type { GrooveState } from "../use-groove";

const grooveIcon = symbol("graphic-eq");
const openIcon = symbol("keyboard-arrow-down");
const deleteIcon = symbol("close");
const resetIcon = symbol("restart-alt");

/**
 * The groove preset picker: a full-width button naming the preset the song's
 * groove was applied from ("Custom" when none, or when that preset has since
 * been deleted), marked "edited" — with a Save that writes the changes back
 * into it — once the groove no longer sounds like it (`grooveEquals`). The
 * button opens the preset menu: Apply a preset (both hands at once), drag a row
 * to reorder the list, reset a built-in preset that was saved over back to its
 * original settings, delete one, or save the current groove as a new one. The
 * song's preset is the menu's highlighted row.
 *
 * The presets are `loading` until the config is known — a loading bar, never
 * the seeds standing in for the user's own list.
 */
export function GroovePresetPicker({ groove }: { groove: GrooveState }) {
  const presets = useGroovePresets();
  switch (presets.status) {
    case "loading":
      return <Loading variant="rows" count={1} />;
    case "error":
      return (
        <ResourceErrorInline
          variant="inline"
          subject="the groove presets"
          error={presets.error}
          refetch={presets.refetch}
        />
      );
    case "ready":
      return <PresetPicker groove={groove} presets={presets.data} />;
  }
}

/** The groove's own fields — its content and provenance, without the writer. */
function fieldsOf(groove: GrooveState): GrooveFields {
  return {
    presetId: groove.presetId,
    bass: groove.bass,
    chord: groove.chord,
    bassFigurationId: groove.bassFigurationId,
    chordFigurationId: groove.chordFigurationId,
    bassVoicing: groove.bassVoicing,
    chordVoicing: groove.chordVoicing,
    restartOnChordChange: groove.restartOnChordChange,
  };
}

function PresetPicker({
  groove,
  presets: { presets, save, update, remove, move },
}: {
  groove: GrooveState;
  presets: GroovePresetsController;
}) {
  const [open, setOpen] = useState(false);
  // The footer's "Save current as a preset…" row, turned into a name field.
  const [naming, setNaming] = useState<string | null>(null);

  const fields = fieldsOf(groove);
  // A dangling id (the preset was deleted) reads as no preset.
  const selected = presets.find((p) => p.id === groove.presetId) ?? null;
  const edited = selected !== null && !grooveEquals(groove, selected);

  const apply = (p: GroovePreset) => {
    groove.commit(presetGroove(p));
    setOpen(false);
  };

  const del = (p: GroovePreset) => {
    remove(p.id);
    // This song's groove came from it: it is now from no preset.
    if (p.id === groove.presetId) {
      groove.commit({ ...fields, presetId: null });
    }
  };

  // Restore a built-in preset saved over. A song in step with it follows it
  // back; a song with its own unsaved edits keeps them.
  const reset = (p: GroovePreset, seed: GroovePreset) => {
    update(p.id, { ...seed, presetId: p.id });
    if (p.id === selected?.id && !edited) {
      groove.commit(presetGroove(seed));
    }
  };

  const saveAsNew = (name: string) => {
    const id = save(name, fields);
    groove.commit({ ...fields, presetId: id });
    setNaming(null);
    setOpen(false);
  };

  return (
    <Stack direction="row" gap="xs" align="center">
      <Fill>
        <ControlPanelPopover
          size="described"
          maxHeight="lg"
          label="Groove presets"
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setNaming(null);
          }}
          trigger={
            <Button
              variant="outline"
              className="w-full"
              aria-label={`Groove preset: ${selected?.name ?? "Custom"}${edited ? " (edited)" : ""}`}
            >
              <Icon icon={grooveIcon} />
              <SingleLineProvider value={true}>
                <Fill as="span">
                  <Text as="span" variant="body">
                    {selected?.name ?? "Custom"}
                  </Text>
                </Fill>
              </SingleLineProvider>
              {edited && <Badge variant="warning">edited</Badge>}
              <Icon icon={openIcon} />
            </Button>
          }
        >
          <ControlPanel.Section>
            {presets.length === 0 ? (
              <ControlPanel.Empty>No saved presets yet.</ControlPanel.Empty>
            ) : (
              <SortableList
                items={presets.map((p) => p.id)}
                orientation="vertical"
                onMove={move}
              >
                {presets.map((p) => {
                  // A built-in preset whose saved content has left its seed.
                  const seed = seedGroovePreset(p.id);
                  const overwritten = seed !== null && !grooveEquals(p, seed);
                  return (
                    // The whole row drags (past the sensor's 4px threshold, so
                    // a click still applies); the row actions' pointerdown
                    // guard keeps a press on them from starting one.
                    <SortableItem
                      key={p.id}
                      id={p.id}
                      className={({ isDragging }) =>
                        cn(isDragging && "opacity-40")
                      }
                    >
                      {() => (
                        <ControlPanel.Row
                          selected={p.id === selected?.id}
                          trailing={grooveSummary(p)}
                          onSelect={() => apply(p)}
                          actions={
                            <>
                              {overwritten && (
                                <IconButton
                                  icon={resetIcon}
                                  label={`Reset “${p.name}” to its original settings`}
                                  onClick={() => reset(p, seed)}
                                />
                              )}
                              <IconButton
                                icon={deleteIcon}
                                label={`Delete preset “${p.name}”`}
                                onClick={() => del(p)}
                              />
                            </>
                          }
                        >
                          {p.name}
                        </ControlPanel.Row>
                      )}
                    </SortableItem>
                  );
                })}
              </SortableList>
            )}
          </ControlPanel.Section>
          <ControlPanel.Footer>
            {naming === null ? (
              <ControlPanel.Row
                muted
                onSelect={() =>
                  setNaming(edited && selected ? `${selected.name} (mine)` : "")
                }
              >
                Save current as a preset…
              </ControlPanel.Row>
            ) : (
              <NameField
                value={naming}
                onChange={setNaming}
                onSubmit={saveAsNew}
              />
            )}
          </ControlPanel.Footer>
        </ControlPanelPopover>
      </Fill>
      {edited && (
        <Button
          variant="ghost"
          title={`Save the changes into “${selected.name}”`}
          onClick={() => update(selected.id, fields)}
        >
          Save
        </Button>
      )}
    </Stack>
  );
}

/** The new preset's name over its Save: Enter submits, an empty name can't. */
function NameField({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (name: string) => void;
}) {
  const name = value.trim();
  const submit = () => {
    if (name !== "") onSubmit(name);
  };
  return (
    <Stack direction="row" gap="xs" align="center">
      <Input
        autoFocus
        value={value}
        placeholder="Preset name"
        aria-label="Preset name"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      />
      <Button disabled={name === ""} onClick={submit}>
        Save
      </Button>
    </Stack>
  );
}
