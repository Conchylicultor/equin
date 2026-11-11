import { useSyncExternalStore } from "react";
import { getSnapshot, subscribe } from "../internal/announcer-store";

/**
 * The page's two live regions, and the only thing this plugin renders.
 *
 * Both are permanently mounted, empty at boot. That is not incidental: a live
 * region has to be in the DOM *before* its text changes for assistive tech to
 * notice the change at all. Mounting a region together with its first message
 * is the classic reason "my aria-live never speaks" — the region and the text
 * arrive in the same commit, so there is no change to observe. Being at
 * `Core.Root`, these two are in the document from the app's first paint and
 * every later write is a change.
 *
 * `sr-only` is `position: absolute` with a 1px clip, so the host occupies no
 * space and perturbs no rect any layout, drag or measurement code reads.
 */
export function AnnouncerHost() {
  const { polite, assertive } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );

  return (
    <>
      {/* `role="status"` carries an implicit `aria-live="polite"`; both are
          spelled out because the pairing is the contract, not an inference the
          next reader of this file should have to make. `aria-atomic` makes the
          region read as one sentence rather than as the diff against what it
          previously held. */}
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {polite}
      </div>
      <div
        className="sr-only"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
      >
        {assertive}
      </div>
    </>
  );
}
