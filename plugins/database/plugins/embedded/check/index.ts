import type {
  Check,
  CheckContext,
} from "@plugins/framework/plugins/tooling/core";
import { parseBunLock } from "@plugins/infra/plugins/deps/plugins/npm/plugins/lock-closure/core";
import { PG_DATA_DIR, PG_MAJOR } from "../shared";

const SERVER_SCOPE = "@embedded-postgres/";

/**
 * The server release the lock names is the cluster's major (`PG_MAJOR`, which
 * names the data dir). A major moving in `bun.lock` — the npm updater rewrites
 * a range across a major — would pin binaries the cluster's start refuses
 * (its data dir only opens with the major that wrote it); failing here makes
 * that a decision at the upgrade, not a cluster that does not come back at its
 * next restart. A major upgrade is a deliberate migration (pg_upgrade), done
 * with `PG_MAJOR` and the binaries moving together.
 */
const serverMajor: Check = {
  id: "embedded:server-major",
  description:
    "every @embedded-postgres package bun.lock resolves is PostgreSQL PG_MAJOR, the cluster's major (its data dir's name)",
  async run(ctx: CheckContext) {
    const text = await (await ctx.repo()).read("bun.lock");
    if (text === null) {
      return {
        ok: false,
        message: "bun.lock is not a file of the working tree",
      };
    }
    const problems: string[] = [];
    let seen = 0;
    for (const [key, entry] of Object.entries(parseBunLock(text).packages)) {
      const spec = entry[0];
      if (typeof spec !== "string" || !spec.startsWith(SERVER_SCOPE)) continue;
      seen++;
      const version = spec.slice(spec.lastIndexOf("@") + 1);
      const major = Number(version.split(".")[0]);
      if (major !== PG_MAJOR) {
        problems.push(
          `${key} resolves to ${spec}: PostgreSQL ${major}, but the cluster is PostgreSQL ${PG_MAJOR}`,
        );
      }
    }
    if (seen === 0) {
      return {
        ok: false,
        message: `bun.lock resolves no ${SERVER_SCOPE}* package: the embedded cluster has no server binaries`,
      };
    }
    return problems.length === 0
      ? { ok: true }
      : {
          ok: false,
          message: problems.join("\n"),
          hint:
            `A major-version upgrade migrates the cluster's data (pg_upgrade from ${PG_DATA_DIR} into a new data-pg<major>), which nothing runs on its own. ` +
            `Keep @embedded-postgres on ${PG_MAJOR} (a hold below the next major in plugins/database/plugins/embedded/package.json's dependencyPolicy), or plan the upgrade with the user.`,
        };
  },
};

export default [serverMajor];
