import { useState } from "react";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { PagesSidebarRow } from "@plugins/apps/plugins/pages/plugins/shell/web";
import { useOpenNewPage } from "../internal/open-new-page";
import { createPageWithSeed } from "../internal/create-page-with-seed";

const addIcon = symbol("add");

/**
 * Sidebar "New page": creates a root page and opens it BESIDE the sidebar
 * (`push` — the Pages sidebar is persistent chrome that stays put, the same
 * mode its tree rows open in), with the caret in its title. A sidebar row of its own, styled like Trash, so
 * the footer reads `New page` / `Trash`; the Private section header's `+` is
 * the same creation, closer to where the page lands.
 *
 * The row disables itself while the page is being created, so a double click
 * cannot mint two pages.
 */
export function NewPageItem() {
  const fetchEndpoint = useFetchEndpoint();
  const openNewPage = useOpenNewPage();
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const id = await createPageWithSeed(fetchEndpoint, { parentId: null });
      openNewPage(id);
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
