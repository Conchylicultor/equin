import { useBrowserNav } from "@plugins/apps/plugins/browser/plugins/shell/web";
import { NewTabButton } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";

/** Opens the current page in the user's real system browser. Disabled on the start page. */
export function OpenExternal() {
  const { current } = useBrowserNav();
  return (
    <NewTabButton
      href={current}
      label="Open in system browser"
      disabled={current === ""}
    />
  );
}
