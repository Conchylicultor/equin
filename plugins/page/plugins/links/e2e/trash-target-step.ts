// One step of the "a link outlives its target's trash" check, against this
// checkout's build: trash a page through the real delete endpoint, or restore a
// trash entry through the real restore endpoint. No edge is written either
// way — check what the readers show between the steps (the Pages sidebar's
// alias under a page linking to it, `page_link_targets` / `page_links` with
// query_db).
//
// Usage:
//   ./equin run plugins/page/plugins/links/e2e/trash-target-step.ts --trash <pageId>
//   ./equin run plugins/page/plugins/links/e2e/trash-target-step.ts --restore <sourceId>/<entryId>
import {
  arg,
  boot,
  pageFetch,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const r = report("page links: trash / restore a target");
const trash = arg("trash");
const restore = arg("restore");

await withBrowser(async (h) => {
  const { page } = await h.session();
  await boot(page, pathUrl("/pages"));
  if (trash !== undefined) {
    const res = await pageFetch(page, `/api/blocks/${trash}`, {
      method: "DELETE",
    });
    const body = await res.text();
    console.log(`DELETE /api/blocks/${trash} -> ${res.status} ${body}`);
    r.ok("the page was trashed", res.ok, body);
  } else if (restore !== undefined) {
    const res = await pageFetch(page, `/api/trash/${restore}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = await res.text();
    console.log(`POST /api/trash/${restore}/restore -> ${res.status} ${body}`);
    r.ok("the entry was restored", res.ok, body);
  } else {
    r.fail("usage", "pass --trash <pageId> or --restore <sourceId>/<entryId>");
  }
  await r.finish();
});
