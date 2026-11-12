import { describe, expect, test } from "bun:test";
import { defineMirrorSet } from "@plugins/database/plugins/table-mirror/plugins/source/server";
import { siteMessagesMirror } from "./mirror";
import { siteMessagesSalt } from "./tables";

// The salt and the salted IP hash make a visitor's hash reproducible from
// their IP: they must never leave the box.
describe("the site_messages mirror set", () => {
  test("mirrors site_messages without ip_hash", () => {
    expect(siteMessagesMirror.tables.map((t) => t.name)).toEqual([
      "site_messages",
    ]);
    const [table] = siteMessagesMirror.tables;
    expect(table!.omit).toEqual(["ip_hash"]);
    expect(table!.columns).not.toContain("ip_hash");
    expect(table!.columns).toContain("message");
  });

  test("listing the salt table in a set throws", () => {
    expect(() =>
      defineMirrorSet({
        id: "site_messages_salt_probe",
        tables: [siteMessagesSalt],
      }),
    ).toThrow(/never|NeverMirrored/i);
  });
});
