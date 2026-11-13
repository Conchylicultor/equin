import type { Check } from "@plugins/framework/plugins/tooling/core";
import { publishedMigrationTreesSignature } from "@plugins/database/plugins/migrations/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { verifySnapshotChain } from "./verify";

const check: Check = {
  id: "snapshot-chain-intact",
  description:
    "schema migrations' snapshot lineage forms one DAG (prevId + merge-node parents) with a single root and a single tip, meta/schema.snapshot.json is that tip, and every header id that must have a body resolves to one",
  // INPUT-KEYED: every working-tree file the verdict reads — the data dir's
  // membership and each file read — comes through `ctx.repo()`, so it is in
  // the read-set, and an edit anywhere else keeps the PASS. What the tree does
  // not hold is git: the published set (a function of the data dir's tree at
  // each published `main`, which the signature names, so a migration landing
  // re-runs it while a push that adds none does not) and the bodies of
  // published and merge nodes (immutable objects of that history).
  inputKeyed: true,
  async cacheSignature(): Promise<string | null> {
    return publishedMigrationTreesSignature(await getWorktreeRoot());
  },
  async run(ctx) {
    return verifySnapshotChain(await ctx.repo());
  },
};

export default check;
