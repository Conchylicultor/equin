import { CompanionFooter } from "@plugins/companions/plugins/panel/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useNativeHost } from "../native-host";

/**
 * The menu-bar panel's footer: the companions' footer, opening equin in the
 * default browser through the helper, or as a plain link when the page is not
 * inside one.
 */
export function PanelFooter() {
  const host = useNativeHost();
  if (host.kind === "pending")
    return <Loading variant="block" className="h-6 w-full" />;
  const openUrl = host.kind === "present" ? host.openUrl : null;
  return (
    <CompanionFooter
      open={openUrl === null ? null : (url) => void openUrl(url)}
    />
  );
}
