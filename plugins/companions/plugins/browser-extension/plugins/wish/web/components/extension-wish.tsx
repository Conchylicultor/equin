import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { useMemo } from "react";
import { PanelSection } from "@plugins/companions/plugins/panel/web";
import { useExtensionHost } from "@plugins/companions/plugins/browser-extension/web";
import {
  DraftPageProvider,
  type DraftPage,
} from "@plugins/tasks/plugins/task-draft-form/web";
import { WishField } from "@plugins/wish/web";

/**
 * The extension's Wish section (BrowserExtension.Section 'wish'): the wish is
 * about the tab the popup was opened on — its URL is what the Page URL toggle
 * attaches. No element picker yet: picking in another tab needs a content
 * script the shell does not have.
 */
export function ExtensionWishSection() {
  const host = useExtensionHost();
  const tab = host.kind === "present" ? host.tab : null;
  const page = useMemo(
    (): DraftPage => ({
      readUrl: tab === null ? null : () => tab.url,
      picker: null,
    }),
    [tab],
  );
  return (
    <PanelSection label="Wish">
      <DraftPageProvider value={page}>
        <WishField
          filedFrom={asPluginId("companions.browser-extension.wish")}
        />
      </DraftPageProvider>
    </PanelSection>
  );
}
