import { describe, expect, test } from "bun:test";
import { workflowRefusal } from "./workflow-refusal";

// Verbatim per-ref lines GitHub sends back, as git prints them.
const OAUTH = `To https://github.com/someone/equin.git
 ! [remote rejected]     update -> update (refusing to allow an OAuth App to create or update workflow \`.github/workflows/installer-release.yml\` without \`workflow\` scope)
error: failed to push some refs to 'https://github.com/someone/equin.git'`;

const PAT = ` ! [remote rejected] main -> main (refusing to allow a Personal Access Token to create or update workflow \`.github/workflows/a.yml\` without \`workflow\` scope)`;

const APP = ` ! [remote rejected] main -> main (refusing to allow a GitHub App to create or update workflow \`.github/workflows/a.yml\` without \`workflows\` permission)`;

describe("workflowRefusal", () => {
  test("the gh CLI's login: an OAuth app without the workflow scope", () => {
    expect(workflowRefusal(OAUTH)).toEqual({
      credential: "oauth-app",
      files: [".github/workflows/installer-release.yml"],
    });
  });

  test("a personal access token, and a GitHub App's permission", () => {
    expect(workflowRefusal(PAT)?.credential).toBe("personal-access-token");
    expect(workflowRefusal(APP)?.credential).toBe("github-app");
  });

  test("two refs refused for one file name it once", () => {
    expect(workflowRefusal(`${PAT}\n${PAT}`)?.files).toEqual([
      ".github/workflows/a.yml",
    ]);
  });

  test("any other refusal is not this one", () => {
    expect(
      workflowRefusal(
        " ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs",
      ),
    ).toBeNull();
    expect(
      workflowRefusal(
        "remote: Permission to x/y.git denied to someone.\nfatal: unable to access",
      ),
    ).toBeNull();
  });
});
