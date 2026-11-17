import { useState } from "react";
import { z } from "zod";
import {
  defineKept,
  useKept,
} from "@plugins/primitives/plugins/kept-state/web";
import { keptPart } from "@plugins/primitives/plugins/kept-state/core";
import type { TaskChainRelateMode } from "@plugins/tasks/core";
import {
  TaskDraftForm,
  makeCard,
  type CardDraft,
} from "../../web/components/task-draft-form";

/**
 * The exhibit's chain: view state of the exhibit. Its cards are the form's
 * own shape, never read back by anything else, so the schema only checks the
 * entry is a list (an unreadable one is not restored).
 */
const formExhibitCards = defineKept({
  owner: "task-draft.form-exhibit",
  tier: "view",
  schema: z.custom<CardDraft[]>(Array.isArray),
});

/**
 * The whole Improve popover form, exhibited on its own (the `task-draft/form` exhibit): the
 * header, the chain of composers with their grips and connectors, and the
 * footer — seeded from the same defaults the popover uses, with the Dependency
 * pill on, as when Improve is opened from a task.
 *
 * An exhibit, not a working copy: adding, reordering, linking and removing
 * tasks all work, but Launch does nothing — nothing is ever filed.
 * There is no real related task behind the Dependency pill, so its follow-up
 * "Insert before" group never appears here.
 */
export default function FormExhibit() {
  const cards = useKept(formExhibitCards, () => [makeCard()]);
  const [autoFocusId, setAutoFocusId] = useState<string | null>(null);
  const [relateMode, setRelateMode] = useState<
    TaskChainRelateMode | undefined
  >();
  return (
    <TaskDraftForm
      cards={keptPart(cards)}
      autoFocusId={autoFocusId}
      onAutoFocusHandled={() => setAutoFocusId(null)}
      submitting={false}
      onSubmit={() => {}}
      onCancel={() => {}}
      relateMode={relateMode}
      onRelateModeChange={setRelateMode}
      showIndependentRelate
      heading="Make a wish"
    />
  );
}
