import { useEffect } from "react";
import { onDraftWriteFailed } from "@plugins/primitives/plugins/persistent-draft/web";
import { showToast } from "@plugins/shell/plugins/toast/web";

// Once per page load: every keystroke after the first refusal fails the same
// way, and one toast is enough to tell the user their typing is not kept.
let warned = false;

/**
 * Tells the user when a draft could not be saved. Without it a refused write is
 * invisible: the editor keeps showing the text, and a reload loses all of it.
 */
export function UnsavedDraftWarning() {
  useEffect(
    () =>
      onDraftWriteFailed((err) => {
        if (warned) return;
        warned = true;
        showToast({
          title: "Drafts are not being saved",
          description:
            err.name === "QuotaExceededError"
              ? "This site's browser storage is full: what you type will be lost on reload. Copy anything you want to keep."
              : `Browser storage refused the write (${err.name}): what you type will be lost on reload.`,
          variant: "error",
        });
      }),
    [],
  );
  return null;
}
