import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boot:closure-digestable",
    paths: ["server/index.ts"],
    kind: "debt",
    task: "task-1793843085-tgrdel",
    reason:
      "The backstop job's `run` body imports checks/core (repoProgram), so the check registry, codegen and lint are in the closure of the backend that schedules it.",
  },
] satisfies Exemptions;
