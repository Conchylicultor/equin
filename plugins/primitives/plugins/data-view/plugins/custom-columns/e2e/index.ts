/**
 * Custom columns from an e2e script: define a surface's columns (its config)
 * and write a cell (the values endpoint) — through the app's own API, as a
 * person editing the Fields panel and a cell would.
 *
 * Every call is an agent-origin request (`agentFetch`): the definitions land in
 * the surface's config file, which the harness's agent-write ledger puts back
 * when the run ends (`withBrowser`); cell values are DB rows the script deletes
 * itself (`clearCustomColumnValues`).
 */
import { agentFetch } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { setConfigField } from "@plugins/config_v2/core";
import type { CustomColumnDef } from "@plugins/primitives/plugins/data-view/plugins/custom-columns/core";
import {
  deleteCustomColumnValues,
  setCustomColumnValue,
  type SetCustomColumnValueBody,
} from "@plugins/primitives/plugins/data-view/plugins/custom-columns/plugins/values/core";

async function post(route: string, body: unknown): Promise<void> {
  const path = route.replace(/^POST /, "");
  const res = await agentFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${route} → HTTP ${res.status}: ${await res.text()}`);
  }
}

/**
 * Write one key of a DataView surface's config (`views`, `customColumns`, …).
 * `storePath` is the surface's config file relative to the config root
 * (`apps/deploy/deploy-history/deploy.deployment.history.jsonc`).
 */
export async function setSurfaceConfig(
  storePath: string,
  key: string,
  value: unknown,
): Promise<void> {
  await post(setConfigField.route, { storePath, key, value });
}

/** Define a surface's custom columns (replacing the list). */
export async function defineCustomColumns(
  storePath: string,
  defs: readonly CustomColumnDef[],
): Promise<void> {
  await setSurfaceConfig(storePath, "customColumns", defs);
}

/** Write one cell (`""` clears it). */
export async function setCustomColumnCell(
  body: SetCustomColumnValueBody,
): Promise<void> {
  await post(setCustomColumnValue.route, body);
}

/** Delete every cell of one column on a surface. */
export async function clearCustomColumnValues(
  dataViewId: string,
  columnId: string,
): Promise<void> {
  await post(deleteCustomColumnValues.route, { dataViewId, columnId });
}
