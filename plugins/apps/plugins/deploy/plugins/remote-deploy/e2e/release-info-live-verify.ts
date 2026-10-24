/**
 * A deployment's release info is LIVE (I7c of
 * research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md): the newest run
 * is the routed `release.history` window (limit 1) and the bundle verdict the
 * external `release.candidate` value — no revision tick, no refetch. And the
 * two are gated so a just-finished build never flashes a stale answer.
 *
 *  1. seeds a server whose last probe reached it and reported `linux-x64`, and a
 *     deployment of a fresh composition on it (no bundle on disk);
 *  2. opens the server's deployments list and the deployment's pane: the
 *     Release chip reads "Not built" and the pane says nothing is built;
 *  3. a candidate run of that composition starts (a row INSERT): the chip
 *     reads "Building", live;
 *  4. its bundle lands on disk (run dir, `RELEASE.json`, the packed binary, the
 *     `latest-linux-x64` pointer) and its row flips to succeeded by hand —
 *     which, unlike the engine's own close, nudges no candidate observation.
 *     The chip must NOT fall back to "Not built": the candidate provably
 *     predates the run, so the info holds `loading` (or, if something else
 *     took a fresh observation meanwhile, already reads "Built");
 *  5. a reload takes a fresh observation: "Built", and the pane names the
 *     platform;
 *  6. a newer run starts — "Building", live — and fails: with a good bundle
 *     still on disk the chip goes back to "Built", live (a failure is not the
 *     state while Ship would still pick the older bundle).
 *
 * Seeds and cleans its own rows and bundle dir (also on failure). A seeded
 * running row carries THIS script's pid, so the supervised-run reconciler (which
 * closes a running row whose pid is dead) sees it alive and leaves it to the
 * script. The seeded server is never probed, so nothing reaches a real host. Refuses main (it
 * seeds rows into the deploy's database).
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/deploy/plugins/remote-deploy/e2e/release-info-live-verify.ts [--headed]
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import {
  arg,
  boot,
  onBeforeFinish,
  openDeployDb,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { ReleaseManifestSchema } from "@plugins/release/plugins/bundles/core";
import { releasesDir } from "@plugins/release/plugins/bundles/data-dirs";

const OUT = arg("out") ?? "/tmp/release-info-live";
const PLATFORM = "linux-x64";

const db = openDeployDb();
const tag = randomBytes(3).toString("hex");
const SERVER = `e2e-srv-${tag}`;
const DEPLOYMENT = `e2e-dep-${tag}`;
const COMPOSITION = `e2e-relinfo-${tag}`;
const RUN = `e2e-release-${tag}-1`;
const NEWER = `e2e-release-${tag}-2`;
/** Where the release CLI would put this composition's web bundles. */
const COMP_DIR = releasesDir.file(db.namespace, `${COMPOSITION}-web`);

let cleaned = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  rmSync(COMP_DIR, { recursive: true, force: true });
  await db.query("DELETE FROM release_runs WHERE composition = $1", [
    COMPOSITION,
  ]);
  // Cascades the deployment and the health row.
  await db.query("DELETE FROM deploy_servers WHERE id = $1", [SERVER]);
  await db.close();
}
onBeforeFinish(cleanup);

/** What the Release chip and the pane currently say, read in one pass. */
async function shown(page: Page): Promise<{
  chip: "Not built" | "Building" | "Built" | "other";
  resolving: boolean;
  builtFor: boolean;
}> {
  const has = async (text: string) =>
    (await page.getByText(text, { exact: true }).count()) > 0;
  const chip = (await has("Building"))
    ? "Building"
    : (await has("Built"))
      ? "Built"
      : (await has("Not built"))
        ? "Not built"
        : "other";
  return {
    chip,
    resolving: await has("Resolving what is built…"),
    builtFor: await has("What is built for this server"),
  };
}

/**
 * Open the seeded deployment's pane from the server page (its Deployments
 * section may start collapsed, below the fold), and its Deploy section.
 */
async function openDeployment(page: Page): Promise<void> {
  const row = page.getByText(COMPOSITION, { exact: true }).first();
  const listed = await waitFor(
    () => row.count(),
    (n) => n > 0,
    { timeoutMs: 5_000 },
  );
  if (!listed.ok) {
    const header = page.getByText("Deployments", { exact: true }).first();
    await header.scrollIntoViewIfNeeded();
    await header.click();
  }
  await row.click();
  // The pane's sections open collapsed — until opened once, which is
  // remembered across a reload.
  const opened = await waitFor(
    () => page.getByText(/^Converges the host/).count(),
    (n) => n > 0,
    { timeoutMs: 3_000 },
  );
  if (!opened.ok) {
    await page.getByText("Deploy to server", { exact: true }).first().click();
  }
}

/** Lay the run's bundle down exactly as a packed candidate release does. */
function writeBundle(): void {
  const runDir = join(COMP_DIR, RUN);
  mkdirSync(join(runDir, "dist"), { recursive: true });
  const manifest = ReleaseManifestSchema.parse({
    composition: COMPOSITION,
    target: "web",
    platform: PLATFORM,
    builtAt: new Date().toISOString(),
    port: 4100,
    runId: RUN,
  });
  writeFileSync(join(runDir, "RELEASE.json"), JSON.stringify(manifest));
  writeFileSync(join(runDir, "dist", `${COMPOSITION}-web-${PLATFORM}`), "");
  symlinkSync(runDir, join(COMP_DIR, `latest-${PLATFORM}`));
}

try {
  await db.query(
    `INSERT INTO deploy_servers (id, name, host) VALUES ($1, $1, 'e2e.invalid')`,
    [SERVER],
  );
  await db.query(
    `INSERT INTO deploy_servers_ext_health (parent_id, ok, checked_at, platform)
     VALUES ($1, true, now(), $2)`,
    [SERVER, PLATFORM],
  );
  await db.query(
    `INSERT INTO deploy_deployments (id, composition_id, server_id, hostnames)
     VALUES ($1, $2, $3, '{}')`,
    [DEPLOYMENT, COMPOSITION, SERVER],
  );

  await withBrowser(async (h) => {
    const r = report("deployment release info — live, never a stale flash");
    const { page } = await h.session();
    await boot(page, pathUrl(`/deploy/server/${SERVER}`), {
      marker: `text=${SERVER}`,
      timeoutMs: 120_000,
      settleMs: 500,
    });
    await openDeployment(page);

    const none = await waitFor(
      () => shown(page),
      (s) => s.chip === "Not built",
      { timeoutMs: 60_000 },
    );
    r.ok("no bundle reads Not built", none.ok, JSON.stringify(none.value));
    r.ok(
      "the pane says Deploy will build it",
      (await page
        .getByText("Nothing built yet — Deploy will build it")
        .count()) > 0,
    );
    await snap(page, OUT, "none");
    await page.evaluate(() => {
      (window as unknown as { __noReload?: boolean }).__noReload = true;
    });

    await db.query(
      `INSERT INTO release_runs (id, composition, target, namespace, kind, status, started_at, platform, pid)
       VALUES ($1, $2, 'web', $3, 'candidate', 'running', now(), $4, $5)`,
      [RUN, COMPOSITION, db.namespace, PLATFORM, process.pid],
    );
    const building = await waitFor(
      () => shown(page),
      (s) => s.chip === "Building",
      { timeoutMs: 30_000 },
    );
    r.ok(
      "a run starting reads Building, live",
      building.ok,
      `${JSON.stringify(building.value)} after ${building.waitedMs}ms`,
    );

    writeBundle();
    await db.query(
      `UPDATE release_runs SET status = 'succeeded', exit_code = 0, finished_at = now()
       WHERE id = $1`,
      [RUN],
    );
    const settled = await waitFor(
      () => shown(page),
      (s) => s.chip !== "Building",
      { timeoutMs: 30_000 },
    );
    r.ok(
      "the run finishing never flashes Not built (held loading, or already Built)",
      settled.ok &&
        (settled.value.chip === "Built" ||
          (settled.value.chip === "other" && settled.value.resolving)),
      JSON.stringify(settled.value),
    );
    // Held for a moment: still no stale answer.
    await page.waitForTimeout(1500);
    const held = await shown(page);
    r.ok(
      "and it stays that way",
      held.chip !== "Not built" && held.chip !== "Building",
      JSON.stringify(held),
    );
    await snap(page, OUT, "finished");

    const noReload = await page.evaluate(
      () => (window as unknown as { __noReload?: boolean }).__noReload === true,
    );
    r.ok("no reload so far", noReload);

    await page.reload();
    await page.getByText(SERVER, { exact: true }).first().waitFor();
    await openDeployment(page);
    const built = await waitFor(
      () => shown(page),
      (s) => s.chip === "Built" && s.builtFor,
      { timeoutMs: 60_000 },
    );
    r.ok(
      "a fresh observation reads Built, and the pane shows what is built",
      built.ok,
      JSON.stringify(built.value),
    );
    r.ok(
      "the pane names the platform",
      (await page.getByText(PLATFORM, { exact: true }).count()) > 0,
    );

    await db.query(
      `INSERT INTO release_runs (id, composition, target, namespace, kind, status, started_at, platform, pid)
       VALUES ($1, $2, 'web', $3, 'candidate', 'running', now(), $4, $5)`,
      [NEWER, COMPOSITION, db.namespace, PLATFORM, process.pid],
    );
    const again = await waitFor(
      () => shown(page),
      (s) => s.chip === "Building",
      { timeoutMs: 30_000 },
    );
    r.ok(
      "a newer run reads Building, live",
      again.ok,
      JSON.stringify(again.value),
    );

    await db.query(
      `UPDATE release_runs SET status = 'failed', exit_code = 1, finished_at = now(),
         error = 'e2e: the build failed'
       WHERE id = $1`,
      [NEWER],
    );
    const failed = await waitFor(
      () => shown(page),
      (s) => s.chip === "Built",
      { timeoutMs: 30_000 },
    );
    r.ok(
      "a failed newer run with a good bundle on disk reads Built, live",
      failed.ok,
      JSON.stringify(failed.value),
    );
    await snap(page, OUT, "after");
    await r.finish();
  });
} finally {
  await cleanup();
}
