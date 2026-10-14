/**
 * The probe verdict's exposure: `ok` reaches every list of servers under the id
 * `status` (what a saved view names), labelled "Status", and a server never
 * probed reads NULL (unknown).
 *
 * Run: `./singularity test plugins/apps/plugins/deploy/plugins/health`.
 */

import { describe, expect, test } from "bun:test";
import { serverHealthShape } from "./schemas";

describe("serverHealthShape.exposure", () => {
  test("exposes ok as `status`, nothing else", () => {
    const { fields, parent } = serverHealthShape.exposure;
    expect(parent.name).toBe("deploy_servers");
    expect(Object.keys(fields)).toEqual(["ok"]);
    expect(fields.ok).toMatchObject({
      id: "status",
      label: "Status",
      absent: null,
    });
    // Every value the wire reads, labelled by its spelling.
    expect(
      Object.entries(fields.ok.options ?? {}).map(([k, o]) => [k, o.label]),
    ).toEqual([
      ["true", "Online"],
      ["false", "Offline"],
      ["null", "Unknown"],
    ]);
  });

  test("the probe's pinned host key never leaves the server", () => {
    expect(Object.keys(serverHealthShape.exposure.fields)).not.toContain(
      "hostKeyLine",
    );
  });
});
