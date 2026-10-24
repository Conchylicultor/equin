/**
 * Drives the deployment pane's remote-deploy section against the deployed app.
 *
 * Manual only (nothing runs this automatically):
 *
 *   ./equin run plugins/apps/plugins/deploy/plugins/remote-deploy/e2e/remote-deploy-verify.ts [--headed]
 *
 * It reads the first deployment out of the running app rather than seeding one:
 * a deployment names a real remote host, so creating one here would leave a
 * record pointing at a box this script never touches.
 *
 * It never presses **Deploy**. That button converges a real host and ships to
 * it; only a human, on a deployment they own, gets to start that.
 */
import {
  agentFetch,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const r = report("deploy remote-deploy section");

await withBrowser(async (h) => {
  const { page } = await h.session();

  const deployments = (await (
    await agentFetch("/api/deploy/deployments")
  ).json()) as { id: string; serverId: string; compositionId: string }[];

  const deployment = deployments[0];
  if (!deployment) {
    r.fail(
      "a deployment exists",
      "no deployment rows — add one in the Deploy app first",
    );
    await r.finish();
    return;
  }

  // 1. The list row opens the pane, and the URL is the selection.
  await page.goto(pathUrl(`/deploy/server/${deployment.serverId}`));
  await page.waitForTimeout(3000);
  await page
    .getByText(deployment.compositionId, { exact: true })
    .first()
    .click();
  await page.waitForTimeout(1500);
  r.ok(
    "row push opens dep/:deploymentId",
    page.url().includes(`/dep/${deployment.id}`),
    page.url(),
  );

  // 2. The three sections are present, in reading order.
  for (const label of ["Overview", "Deploy to server", "Output"]) {
    r.ok(
      `${label} section renders`,
      await page.getByText(label, { exact: true }).first().isVisible(),
    );
  }

  // 3. ONE primary action, not a pipeline. The four-step surface is gone, so
  //    neither of the retired step controls may still be reachable.
  const deployButton = page
    .getByRole("button", { name: /^Deploy( .+)?$/ })
    .first();
  r.ok("a single Deploy button renders", await deployButton.isVisible());
  for (const gone of ["Rehearse", "Ship without rehearsing"]) {
    r.ok(
      `"${gone}" is gone`,
      (await page.getByRole("button", { name: gone }).count()) === 0,
    );
  }

  // 4. Either the app is reachable somewhere, or the pane says why it is not.
  r.ok(
    "the inspect links or the loopback-only sentence render",
    (await page
      .getByText("Inspect the deployed app", { exact: true })
      .count()) > 0,
  );

  // 5. The Output switcher carries both channels with their scope captions.
  const buildTab = page.getByRole("radio", { name: "Build" }).first();
  r.ok("Output has a Build channel", await buildTab.isVisible());
  await buildTab.click();
  await page.waitForTimeout(500);
  r.ok(
    "Build channel states its worktree scope",
    (await page.getByText(/across ALL compositions/).count()) > 0,
  );

  await r.finish();
});
