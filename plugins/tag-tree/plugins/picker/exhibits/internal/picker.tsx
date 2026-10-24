import { useState } from "react";
import { TagPickerPanel } from "../../web/components/tag-picker-panel";
import { FIXTURE_COUNTS, FIXTURE_TAGS, NO_WRITES } from "./fixtures";

/** The picker panel over the mockup's tree, `homepage` picked; picking moves the ✓, edits change nothing. */
export default function TagPickerExhibit() {
  const [selected, setSelected] = useState<string | null>("app-website-home");
  return (
    <TagPickerPanel
      tags={FIXTURE_TAGS}
      writes={NO_WRITES}
      selected={selected === null ? [] : [selected]}
      counts={FIXTURE_COUNTS}
      offerNone
      onPick={(id) => {
        if (id === null || FIXTURE_TAGS.some((t) => t.id === id))
          setSelected(id);
      }}
    />
  );
}
