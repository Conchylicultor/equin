import { useEffect } from "react";
import {
  onStorageFailure,
  type StorageFailure,
} from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { showToast } from "@plugins/shell/plugins/toast/web";

// Once per owner per page load: every keystroke after the first refusal fails
// the same way, and one toast per kind of thing being lost is enough.
const warned = new Set<string>();

function describe(f: StorageFailure): string {
  switch (f.reason) {
    case "over-cap":
      return `They reached their storage cap: what changes now is lost on reload. Open the health report (Browser storage) to see what fills it.`;
    case "quota":
      return `This site's browser storage is full: what changes now is lost on reload. Open the health report (Browser storage) to see who fills it.`;
    case "blocked":
      return `Browser storage refused the write${f.error ? ` (${f.error})` : ""}: what changes now is lost on reload.`;
    case "corrupt":
      return "";
  }
}

/**
 * Tells the user when something could not be saved. Without it a refused write
 * is invisible: the surface keeps showing the value, and a reload loses it. An
 * unreadable entry is not the user's to act on — it files a report instead.
 */
export function StorageFailureToast() {
  useEffect(
    () =>
      onStorageFailure((f) => {
        if (f.reason === "corrupt" || warned.has(f.owner)) return;
        warned.add(f.owner);
        showToast({
          title: `${f.label} are not being saved`,
          description: describe(f),
          variant: "error",
        });
      }),
    [],
  );
  return null;
}
