import { describe, expect, test } from "bun:test";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import type { ClaudeCodeStatus } from "@plugins/infra/plugins/claude-cli/plugins/availability/core";
import { cliDriftVerdict, type CliDriftInputs } from "./cli-drift";

const refetch = () => Promise.resolve();
const sdk = { sdkVersion: "0.3.303", cliVersion: "2.1.303" };
const loaded = (claude: ClaudeCodeStatus): ResourceResult<CliDriftInputs> => ({
  status: "ready",
  data: { claude, sdk },
  refetch,
});
const ready = (version: string) =>
  loaded({ kind: "ready", version, authMethod: null, email: null });

describe("cliDriftVerdict", () => {
  test("same major.minor is ok, whatever the patch", () => {
    expect(cliDriftVerdict(ready("2.1.999")).state).toBe("ok");
  });

  test("another minor is attention", () => {
    expect(cliDriftVerdict(ready("2.2.0")).state).toBe("attention");
  });

  test("not known yet is unknown, never ok", () => {
    expect(cliDriftVerdict({ status: "loading", refetch }).state).toBe(
      "unknown",
    );
    expect(
      cliDriftVerdict(loaded({ kind: "missing", searched: [] })).state,
    ).toBe("unknown");
  });

  test("no computer to read the versions from is not applicable, with why", () => {
    expect(
      cliDriftVerdict({ status: "unavailable", message: "Not here." }),
    ).toEqual({ state: "not-applicable", summary: "Not here." });
  });
});
