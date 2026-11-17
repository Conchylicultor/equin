import type { ReactNode } from "react";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { useFilterPresets } from "../../internal/use-filter-presets";
import { filterPresetMatchesGroup } from "../../internal/sort-presets";
import { useDataViewControls } from "../controls/controls-context";
import { PresetSection, type PresetEntry } from "../presets/preset-section";
import { SavePresetPanel } from "../presets/save-preset-panel";

/**
 * The filter panel's two preset surfaces — the twin of the sort ones, and for
 * the same reason the pushed one reads the presets config LIVE rather than
 * taking it as a prop: a panel-stack entry's `render` closure is captured when
 * the row is clicked.
 *
 * A filter preset has no partial-resolution notion (the whole tree applies or
 * nothing does), so every entry is applicable.
 */

function useFilterPresetEntries(): {
  entries: PresetEntry[];
  apply: (id: string) => void;
  deletePreset: (id: string) => void;
} {
  const { storageKey, filter } = useDataViewControls();
  const presets = useFilterPresets(storageKey);

  const entries = presets.presets.map((preset) => ({
    id: preset.id,
    label: preset.label,
    active: filterPresetMatchesGroup(preset, filter.filter),
  }));

  return {
    entries,
    apply: (id) => {
      const preset = presets.presets.find((p) => p.id === id);
      if (preset) filter.setFilter(preset.group);
    },
    // The row's trash is one click and takes a whole filter tree with it, which
    // nothing can reconstruct — so the preset AND its position are captured
    // before the delete and handed to the toast's Undo. Restoring at the end of
    // the list would be a different list, so the index travels too.
    deletePreset: (id) => {
      const index = presets.presets.findIndex((p) => p.id === id);
      const preset = presets.presets[index];
      if (!preset) {
        // The only rows that can fire this are rows built from this same list,
        // so a miss is a bug in the wiring, not a state a user can reach.
        throw new Error(`data-view: no filter preset "${id}" to delete.`);
      }
      presets.deletePreset(id);
      showToast({
        description: `Deleted preset “${preset.label}”`,
        action: {
          label: "Undo",
          onClick: () => presets.restorePreset(preset, index),
        },
      });
    },
  };
}

/** The "Presets" section at the top of the filter panel. Null when there are none. */
export function FilterPresetSection(): ReactNode {
  const { entries, apply, deletePreset } = useFilterPresetEntries();
  return (
    <PresetSection entries={entries} onApply={apply} onDelete={deletePreset} />
  );
}

/** The pushed "Save as preset" page — captures the live filter tree on submit. */
export function FilterSavePresetPanel(): ReactNode {
  const { storageKey, filter } = useDataViewControls();
  const presets = useFilterPresets(storageKey);
  return (
    <SavePresetPanel
      kind="filter"
      onSave={(label) => {
        if (filter.filter) presets.savePreset(label, filter.filter);
      }}
    />
  );
}
