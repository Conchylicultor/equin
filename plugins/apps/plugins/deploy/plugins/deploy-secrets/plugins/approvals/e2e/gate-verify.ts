// Deploy-secrets gate, end to end, on a worktree build.
//
// The gate reads which secrets a composition's closure declares off the
// faceted plugin tree, which a backend reads as data from a worker thread
// (`plugin-tree`'s FacetedTreeSource → `plugin-tree/faceted`'s worker). This
// drives a real run through the real gate and asserts its verdict:
//
//   --expect needs-approval (default): a fresh deployment of a composition
//     whose closure declares a secret, with no grants, ends `needs-approval`
//     naming the secret — required and recognised, nothing converged.
//   --expect failed: run with the worker broken on purpose (by hand, between
//     runs): the run ends `failed`, never `needs-approval` and never past the
//     gate — a tree that cannot be read must not pass the gate.
//
// Throwaway rows only: a server on 192.0.2.1 (TEST-NET-1, unroutable, no SSH
// key) and one deployment on it, both deleted at the end. Never point it at a
// real deployment: a run the gate passes converges for real.
//
// Usage: ./equin run plugins/apps/plugins/deploy/plugins/deploy-secrets/plugins/approvals/e2e/gate-verify.ts \
//          [--composition website] [--expect needs-approval|failed]
import {
  arg,
  openDeployDb,
  pageFetch,
  pathUrl,
  report,
  usage,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const composition = arg("composition", "website");
const expect = arg("expect", "needs-approval");
if (expect !== "needs-approval" && expect !== "failed")
  usage(`--expect must be needs-approval or failed, got "${expect}"`);

/** A cold faceted-tree read on a loaded host can take minutes. */
const RUN_SETTLED_TIMEOUT_MS = 6 * 60_000;

const r = report(`deploy-secrets gate (${composition}, expect ${expect})`);
const db = openDeployDb();

/** What marks this script's rows, so a killed run's leftovers are found. */
const SERVER_NAME = "gate-verify (throwaway)";

interface RunRow extends Record<string, unknown> {
  status: string;
  message: string | null;
  exit_code: number | null;
  finished_at: Date | null;
}

await withBrowser(async (h) => {
  const { page } = await h.session();
  await page.goto(pathUrl("/deploy"));

  const post = async (path: string, body: unknown): Promise<unknown> => {
    const res = await pageFetch(page, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${text}`);
    return JSON.parse(text) as unknown;
  };
  const del = async (path: string): Promise<void> => {
    const res = await pageFetch(page, path, { method: "DELETE" });
    if (!res.ok)
      throw new Error(`DELETE ${path} → ${res.status}: ${await res.text()}`);
  };
  /** Every row this script ever seeded: its servers, their deployments and runs. */
  const sweep = async (): Promise<void> => {
    const servers = await db.query<{ id: string }>(
      "SELECT id FROM deploy_servers WHERE name = $1",
      [SERVER_NAME],
    );
    for (const { id } of servers) {
      const deployments = await db.query<{ id: string }>(
        "SELECT id FROM deploy_deployments WHERE server_id = $1",
        [id],
      );
      for (const d of deployments) {
        await db.query("DELETE FROM deploy_runs WHERE deployment_id = $1", [
          d.id,
        ]);
        await del(`/api/deploy/deployments/${d.id}`);
      }
      await del(`/api/deploy/servers/${id}`);
    }
  };

  await sweep();
  try {
    const server = (await post("/api/deploy/servers", {
      name: SERVER_NAME,
      host: "192.0.2.1",
    })) as { id: string };
    const deployment = (await post("/api/deploy/deployments", {
      compositionId: composition,
      serverId: server.id,
      hostnames: ["gate-verify.invalid"],
    })) as { id: string };
    r.note(`server ${server.id}, deployment ${deployment.id}`);

    const run = (await post(`/api/deploy/deployments/${deployment.id}/run`, {
      verb: "converge",
    })) as { id: string };
    r.note(`run ${run.id}`);

    const settled = await waitFor(
      async () => {
        const [row] = await db.query<RunRow>(
          "SELECT status, message, exit_code, finished_at FROM deploy_runs WHERE id = $1",
          [run.id],
        );
        return row;
      },
      (row) => row?.finished_at != null,
      { timeoutMs: RUN_SETTLED_TIMEOUT_MS, intervalMs: 1_000 },
    );
    if (!settled.ok || settled.value === undefined) {
      r.fail(
        "run settled",
        `after ${settled.waitedMs} ms: ${JSON.stringify(settled.value ?? null)}`,
      );
      return;
    }
    const row: RunRow = settled.value;
    r.note(`status ${row.status}: ${row.message ?? "(no message)"}`);
    r.eq("run verdict", row.status, expect);
    // Only a leg that ran stamps an exit code; a gate verdict (held or thrown)
    // ends the run before any leg.
    r.ok(
      "no leg ran (the gate decided before converge)",
      row.exit_code === null,
      `exit code ${row.exit_code}`,
    );
    r.ok(
      "the verdict says why",
      typeof row.message === "string" && row.message.length > 0,
    );
  } finally {
    await sweep();
  }
});

await db.close();
await r.finish();
