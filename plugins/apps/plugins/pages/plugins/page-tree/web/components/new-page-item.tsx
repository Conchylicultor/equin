import { useState } from "react";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { PagesSidebarRow } from "@plugins/apps/plugins/pages/plugins/shell/web";
import { pageDetailPane } from "../panes";
import { createPageWithSeed } from "../internal/create-page-with-seed";

const addIcon = symbol("add");

/**
 * Sidebar "New page": creates a root page and opens it BESIDE the sidebar
 * (`push` — the Pages sidebar is persistent chrome that stays put, the same
 * mode its tree rows open in). A sidebar row of its own, styled like Trash, so
 * the footer reads `New page` / `Trash`; the Private section header's `+` is
 * the same creation, closer to where the page lands.
 *
 * The row disables itself while the page is being created, so a double click
 * cannot mint two pages.
 */
export function NewPageItem() {
  const fetchEndpoint = useFetchEndpoint();
  const openPane = useOpenPane();
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const id = await createPageWithSeed(fetchEndpoint, { parentId: null });
      openPane(pageDetailPane, { pageId: id }, { mode: "push" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <PagesSidebarRow
      icon={addIcon}
      label="New page"
      tone="muted"
      disabled={busy}
      onClick={() => void create()}
    />
  );
}
