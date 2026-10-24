// The "BYPASS ACTIVE" chip follows a bypass file's creation and removal while
// the page stays open — pushed by the server's file watcher, with no request to
// the old polled endpoint.
//
// Usage:
//   ./equin run plugins/conversations/plugins/conversation-view/plugins/allow-monitor/e2e/allow-chip.ts \
//     --conversation <conv-id> --worktree <that conversation's worktree path> [--token .allow-postgres]
//
// The token file is created at the worktree root for a few seconds, so the
// guard it names is bypassed for that long. It is always removed, pass or fail.

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  arg,
  onBeforeFinish,
  pathUrl,
  report,
  requireArg,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const USAGE =
  "allow-chip.ts --conversation <conv-id> --worktree <path> [--token .allow-postgres] [--out /tmp/allow-chip]";
const conversation = requireArg("conversation", USAGE);
const worktree = requireArg("worktree", USAGE);
const token = arg("token", ".allow-postgres");
const out = arg("out", "/tmp/allow-chip");
const tokenPath = join(worktree, token);

if (existsSync(tokenPath)) {
  throw new Error(
    `${tokenPath} already exists — refusing to remove a bypass the user created`,
  );
}

const r = report("allow-monitor chip is pushed");
onBeforeFinish(async () => rmSync(tokenPath, { force: true }));

await withBrowser(async (h) => {
  const { page } = await h.session();
  const polled: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/allow-files")) polled.push(req.url());
  });

  await page.goto(pathUrl(`/agents/c/${conversation}`));
  const chip = page.getByRole("button", { name: "Security bypass active" });
  const visible = () => chip.isVisible();

  const initial = await waitFor(visible, (v) => !v, { timeoutMs: 5_000 });
  r.ok("no chip before the bypass file exists", initial.ok);

  writeFileSync(tokenPath, "");
  try {
    const shown = await waitFor(visible, (v) => v, { timeoutMs: 30_000 });
    r.ok("chip appears after the file is created", shown.ok);
    r.note(`appeared after ${shown.waitedMs} ms`);
    await snap(page, out, "on");
    if (shown.ok) {
      await chip.hover();
      const tip = await waitFor(
        // The visible tooltip body, found by its heading (the role="tooltip"
        // node is a visually-hidden copy for screen readers).
        () =>
          page
            .getByText("Guard bypasses active:", { exact: true })
            .locator("..")
            .getByText(token, { exact: true })
            .isVisible(),
        (v) => v,
        { timeoutMs: 10_000 },
      );
      r.ok(`tooltip names ${token}`, tip.ok);
    }
  } finally {
    // Removed here, not only at finish: a throw above skips finish().
    rmSync(tokenPath, { force: true });
  }
  const hidden = await waitFor(visible, (v) => !v, { timeoutMs: 30_000 });
  r.ok("chip disappears after the file is removed", hidden.ok);
  r.note(`disappeared after ${hidden.waitedMs} ms`);

  r.eq("no request to the old polled endpoint", polled, []);
});

await r.finish();
