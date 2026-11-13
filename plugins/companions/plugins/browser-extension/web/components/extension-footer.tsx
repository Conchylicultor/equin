import { CompanionFooter } from "@plugins/companions/plugins/panel/web";
import { useExtensionHost } from "../host";

/** The panel's footer: opening equin in a new tab through the extension. */
export function ExtensionFooter() {
  const host = useExtensionHost();
  const openTab = host.kind === "present" ? host.openTab : null;
  return (
    <CompanionFooter
      open={openTab === null ? null : (url) => void openTab(url)}
    />
  );
}
