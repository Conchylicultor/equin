import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleList } from "./internal/handle-list";
import { handleGet } from "./internal/handle-get";
import { handleCreate } from "./internal/handle-create";
import { handleUpdate } from "./internal/handle-update";
import { handleDelete } from "./internal/handle-delete";
import { handleRun } from "./internal/handle-run";
import {
  deploymentsServed,
  deployRunHistoryServed,
} from "./internal/resources";
import {
  deployRunsServed,
  reconcileDeployLiveView,
} from "./internal/run-state";
import { deployRunJob } from "./internal/run-deploy";
import { deployRunRetention } from "./internal/retention";
import {
  listDeployments,
  createDeployment,
  getDeployment,
  updateDeployment,
  deleteDeployment,
  runDeployment,
} from "../core/endpoints";
import { IdKinds } from "@plugins/ids/server";
import { deploymentIdKind, deployRunIdKind } from "../core";

export { _deployDeployments, _deployRuns } from "./internal/tables";

export default {
  description:
    "Owns the deploy_deployments table: where a composition is served and under what URL ((composition × server) → { hostnames, loopbackPort }), its live collection, and the CRUD endpoints. Also launches `./equin deploy converge|ship` for a deployment — and orchestrates the `update` sequence (converge → build a candidate unless one is already current → ship that pinned run id) over the awaitable release engine — streaming the CLI's output into the durable `deploy` log channel, each run's phase and outcome into the in-memory `deploy.runs` live view, and every run into the durable `deploy_runs` ledger it serves back as a live history window — the record that survives the restart the live view does not. The install itself — run user, dir layout, systemd unit, Caddy site — is derived in core/, never stored.",
  httpRoutes: {
    [listDeployments.route]: handleList,
    [createDeployment.route]: handleCreate,
    [getDeployment.route]: handleGet,
    [updateDeployment.route]: handleUpdate,
    [deleteDeployment.route]: handleDelete,
    [runDeployment.route]: handleRun,
  },
  contributions: [
    IdKinds.Kind({ kind: deploymentIdKind }),
    IdKinds.Kind({ kind: deployRunIdKind }),
    ...deploymentsServed.declare,
    ...deployRunsServed.declare,
    ...deployRunHistoryServed.declare,
  ],
  // `deployRunJob` mounts the queue job AND its supervised-run kind in one
  // token: the supervisor's single boot reconciler loops the kinds registered by
  // the time its own `onReady` runs, so an unmounted job would start CLI legs
  // that nothing ever adopts or closes.
  register: [deployRunRetention, deployRunJob],
  onReady: async () => {
    // The live view is process memory and died with the last backend. The
    // supervisor's reconciler rebuilds the runs with a live LEG (the ledger's
    // `onReattach`), but an `update` in its release build has no leg — its
    // sequence is a suspended workflow — so this is the one thing that can put
    // it back on screen before that workflow's next wake.
    await reconcileDeployLiveView();
  },
} satisfies ServerPluginDefinition;
