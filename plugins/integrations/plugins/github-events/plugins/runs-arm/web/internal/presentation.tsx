import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { githubRunArm } from "../../core";

/**
 * How the GitHub arm's fields present in every list of the runs union. The
 * label already says the workflow and its ref, so only the conclusion-free
 * dimensions a person filters by stay one click away in Properties.
 */
export const githubRunPresentation = FieldPresentation.Register({
  owner: githubRunArm,
  fields: {
    workflowName: { groupable: true, visible: false, width: "10rem" },
    head: { visible: false, width: "10rem" },
    repo: { groupable: true, visible: false, width: "10rem" },
    headSha: {
      cell: (sha) => (
        <Badge variant="muted" mono tooltip={sha}>
          {sha.slice(0, 8)}
        </Badge>
      ),
      visible: false,
      width: "8rem",
    },
    status: { visible: false, width: "8rem" },
    conclusion: { visible: false, width: "8rem" },
    attempt: { visible: false, width: "5rem" },
  },
});
