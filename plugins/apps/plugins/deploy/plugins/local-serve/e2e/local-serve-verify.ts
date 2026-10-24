/**
 * Drives the deployment pane's Test-locally section and the deployments row's
 * serve shortcut against the deployed app.
 *
 * Manual only (nothing runs this automatically):
 *
 *   ./equin run plugins/apps/plugins/deploy/plugins/local-serve/e2e/local-serve-verify.ts [--headed]
 *
 * It reads the first deployment out of the running app rather than seeding one,
 * for the same reason the remote-deploy script does: a deployment names a real
 * remote host.
 *
 * It never presses **Serve**. That kicks a full main build; only a human decides
 * to spend one.
 */
import {
  agentFetch,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const r = report("deploy local-serve section");

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

  // 1. The status endpoint answers about the namespace, in the shape the UI
  //    branches on. Asked directly because the served arm is the one a laptop
  //    with nothing served cannot show on screen.
  const status = (await (
    await agentFetch(
      `/api/build/serve/status?composition=${encodeURIComponent(deployment.compositionId)}`,
    )
  ).json()) as {
    namespace: string;
    url: string;
    liveness: { served: boolean };
  };
  r.ok(
    "serve status answers a server-resolved namespace + url + a discriminated liveness",
    typeof status.namespace === "string" &&
      status.url.includes(status.namespace) &&
      typeof status.liveness.served === "boolean",
    JSON.stringify(status),
  );

  // 2. The section is in the pane, ahead of the remote one — rehearse, then ship.
  await page.goto(
    pathUrl(`/deploy/server/${deployment.serverId}/dep/${deployment.id}`),
  );
  await page.waitForTimeout(3000);
  const order = await page.evaluate(() => document.body.innerText);
  r.ok(
    "Test locally renders before Deploy to server",
    order.includes("Test locally") &&
      order.indexOf("Test locally") < order.indexOf("Deploy to server"),
  );

  await page.getByText("Test locally", { exact: true }).first().click();
  await page.waitForTimeout(1000);

  // 3. What it proves is stated, not implied.
  r.ok(
    "the section states what the local serve does NOT prove",
    (await page.getByText(/does not exercise packaging/i).count()) > 0,
  );

  // 4. No main-only refusal anywhere: a serve is an ordinary build of whichever
  //    checkout is being looked at, so the sentence that used to lead this pane
  //    would now be false in exactly the case it was written for.
  const refusal = await page.getByText(/run on the main instance only/).count();
  r.ok(
    "the retired main-only refusal is gone from the pane",
    refusal === 0,
    `refusalCount=${refusal}`,
  );

  // 5. The live-only affordances (the URL chip's neighbours — Reset is the
  //    unambiguous one) appear if and ONLY if the marker says served. This is
  //    the regression the honest-liveness read exists to prevent: `autoBuild`
  //    alone used to be enough to paint them.
  const resetButtons = await page
    .getByRole("button", { name: "Reset" })
    .count();
  r.ok(
    "live-only affordances track the marker, not the autoBuild intent",
    status.liveness.served ? resetButtons > 0 : resetButtons === 0,
    `served=${status.liveness.served} resetButtons=${resetButtons}`,
  );

  // 6. The row shortcut exists on the list (hover-revealed, so it is queried by
  //    its accessible name rather than looked for in a screenshot).
  await page.goto(pathUrl(`/deploy/server/${deployment.serverId}`));
  await page.waitForTimeout(2500);
  await page.getByText("Deployments", { exact: true }).first().click();
  await page.waitForTimeout(1500);
  const serveAction = page.getByRole("button", {
    name: /Serve locally|Open the local serve/,
  });
  r.ok("the row carries a serve shortcut", (await serveAction.count()) > 0);

  await r.finish();
});
