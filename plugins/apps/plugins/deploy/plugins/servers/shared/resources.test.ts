/**
 * The servers list's derived fields: the ids a saved view names (`name`) are
 * unchanged, the address is the list's own, and the row carries the record the
 * detail pane and the pickers read — but never the derived key.
 *
 * Run: `./singularity test plugins/apps/plugins/deploy/plugins/servers`.
 */

import { describe, expect, test } from "bun:test";
import { servers } from "./resources";

describe("deploy.servers", () => {
  test("lists the name; the rest of the record rides on the row", () => {
    expect(Object.keys(servers.fields)).toEqual(["name"]);
    expect(servers.fields.name).toMatchObject({ label: "Name", primary: true });
    expect([...servers.rowKeys].map(String).sort()).toEqual(
      [
        "consoleUrl",
        "createdAt",
        "host",
        "id",
        "name",
        "port",
        "sshUser",
        "updatedAt",
      ].sort(),
    );
  });

  test("reaches the deploy_servers entity, so its exposures fold in", () => {
    expect(servers.from?.name).toBe("deploy_servers");
  });
});
