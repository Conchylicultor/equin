import { describe, expect, test } from "bun:test";
import { processKindOf, processName } from "./name";

describe("processName", () => {
  test("kind first, then the id", () => {
    expect(processName("build", "att-1793455063-w71oiq")).toBe(
      "equin · build · att-1793455063-w71oiq",
    );
    expect(processName("central")).toBe("equin · central");
  });

  test("a slash or control character never reaches the file name", () => {
    expect(processName("run", "a/b\nc")).toBe("equin · run · a b c");
  });
});

describe("processKindOf", () => {
  test("reads the kind back from the executable path", () => {
    expect(
      processKindOf("/h/u/.equin/worktrees/att-1/bin/equin · server · att-1"),
    ).toBe("server");
    expect(
      processKindOf(
        "/h/u/.equin/state/sdk-agents/x/conv-1/bin/equin · agent · conv-1 /repo/agent.ts --x",
      ),
    ).toBe("agent");
    expect(
      processKindOf(
        "/h/u/.equin/cache/process-names/bun-1.4.4/processes/equin · agent /repo/agent.ts --dir /h/u/x",
      ),
    ).toBe("agent");
    expect(
      processKindOf(
        "node_modules/.cache/equin-bun/verbs/equin · build plugins/cli/bin/index.ts build",
      ),
    ).toBe("build");
    expect(processKindOf("equin · central")).toBe("central");
  });

  test("a process not named so, or named so only in an argument, has none", () => {
    expect(processKindOf("/opt/bun/bun plugins/cli/bin/index.ts check")).toBe(
      null,
    );
    expect(processKindOf("/bin/zsh -c echo /tmp/equin · build x")).toBe(null);
    expect(processKindOf("equinox")).toBe(null);
  });

  test("round-trips processName", () => {
    expect(processKindOf(`/a/${processName("server", "att-2")}`)).toBe(
      "server",
    );
  });
});
