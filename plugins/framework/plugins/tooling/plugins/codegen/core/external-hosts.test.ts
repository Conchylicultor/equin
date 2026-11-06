import { expect, test } from "bun:test";
import { parseExternalHostsDeclarations } from "./external-hosts";

test("reads each ExternalHosts.Declare contribution's hosts and reason", () => {
  const src = `
    // ExternalHosts.Declare({ hosts: ["in.a.comment"], reason: "no" })
    export default {
      contributions: [
        ExternalHosts.Declare({
          hosts: ["maps.googleapis.com", "maps.gstatic.com"],
          reason: "Google's map: " + "its script and tiles",
        }),
        Other.Declare({ hosts: ["not.ours.com"], reason: "x" }),
      ],
    };`;
  expect(parseExternalHostsDeclarations(src)).toEqual([
    {
      hosts: ["maps.googleapis.com", "maps.gstatic.com"],
      reason: "Google's map: its script and tiles",
    },
  ]);
});

test("refuses a host it cannot read, or one that is not a host name", () => {
  expect(() =>
    parseExternalHostsDeclarations(
      `ExternalHosts.Declare({ hosts: HOSTS, reason: "r" })`,
    ),
  ).toThrow(/read statically/);
  expect(() =>
    parseExternalHostsDeclarations(
      `ExternalHosts.Declare({ hosts: ["https://x.com/a"], reason: "r" })`,
    ),
  ).toThrow(/not a host name/);
});
