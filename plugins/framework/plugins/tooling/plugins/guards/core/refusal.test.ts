import { describe, expect, test } from "bun:test";
import { withRefusalBanner } from "./refusal";

describe("withRefusalBanner", () => {
  test("a compound Bash call lists every sub-command as not run", () => {
    // The measured case: an inline edit denied along with the check after it.
    const command = [
      "cd plugins/ui && python3 - <<'EOF'",
      "open('a.tsx','w').write('x')",
      "EOF",
      "./equin check type-check",
    ].join("\n");
    const msg = withRefusalBanner("Bash", { command }, "run it in background");
    expect(
      msg.startsWith("BLOCKED BY A GUARD: this tool call did NOT run."),
    ).toBe(true);
    expect(msg).toContain("None of its 3 sub-commands was executed");
    expect(msg).toContain("did NOT happen");
    expect(msg.endsWith("Why it was blocked:\nrun it in background")).toBe(
      true,
    );
  });

  test("a single Bash command says it was not executed", () => {
    const msg = withRefusalBanner("Bash", { command: "git push" }, "no");
    expect(msg).toContain("The command was not executed at all.");
    expect(msg).not.toContain("sub-commands");
  });

  test("file tools name the file left unchanged", () => {
    expect(withRefusalBanner("Edit", { file_path: "/x/a.ts" }, "r")).toContain(
      "The edit was NOT applied: /x/a.ts is unchanged on disk.",
    );
    expect(withRefusalBanner("Write", { file_path: "/x/b.ts" }, "r")).toContain(
      "The file was NOT written: /x/b.ts",
    );
  });

  test("an unknown tool still gets the header", () => {
    expect(withRefusalBanner("Mystery", {}, "r")).toStartWith(
      "BLOCKED BY A GUARD: this tool call did NOT run. None of its effects happened.",
    );
  });
});
