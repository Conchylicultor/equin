import { describe, expect, test } from "bun:test";
import { renderNotice } from "@plugins/infra/plugins/launcher/plugins/installer-notice/core";
import { RUN_AS_ROOT } from "./run-as-root";

describe("the run-as-root refusal", () => {
  test("keeps the installer message rules, the cause apart under Details", () => {
    // defineNotice already refused it at load had it broken a rule.
    const [message, evidence] = renderNotice(RUN_AS_ROOT).split(
      "Details (for a bug report):",
    );
    expect(message).not.toMatch(/initdb|embedded cluster|backend/);
    expect(message).toContain("`adduser --disabled-password --gecos '' equin`");
    expect(evidence).toContain("initdb");
  });
});
