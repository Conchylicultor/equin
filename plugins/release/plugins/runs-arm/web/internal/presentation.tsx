import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { releaseRunArm } from "../../core";

/**
 * How the release arm's fields present in every list of the runs union. A
 * cell is handed this arm's value only — a build row's `Platform` is blank —
 * so nothing here checks the kind.
 *
 * Most are off by default. The merged surface's job is "what is running on this
 * machine", and seven release columns on by default would push every other
 * kind's row off the right edge of the table to say things only one kind can
 * say. They stay one click away in the view's Properties list, and they filter,
 * sort and group whether or not they are shown.
 */
export const releaseRunPresentation = FieldPresentation.Register({
  owner: releaseRunArm,
  fields: {
    kind: { width: "9rem" },
    // The one release dimension worth a column by default: it is what a person
    // means by "which release", and grouping runs by it is the obvious question.
    composition: { groupable: true, width: "10rem" },
    target: { visible: false, width: "9rem" },
    platform: { visible: false, width: "9rem" },
    commitSha: {
      cell: (sha, run) => {
        if (sha === null) return null;
        // The dirty flag belongs ON the sha, not beside it: a dirty run's sha
        // names its PARENT commit, not its bytes, so the sha alone is a claim
        // the row cannot support. Rendering them apart lets someone read the
        // first without the second.
        const dirty = releaseRunArm.read(run)?.commitDirty ?? null;
        return (
          <Badge
            variant={dirty === true ? "warning" : "muted"}
            mono
            tooltip={dirty === true ? `${sha} (tree was dirty)` : sha}
          >
            {sha.slice(0, 8)}
            {dirty === true ? "+" : ""}
          </Badge>
        );
      },
      visible: false,
      width: "8rem",
    },
    commitDirty: { visible: false, width: "6rem" },
    artifactPath: {
      cell: (path) =>
        path === null ? null : (
          <span className="text-muted-foreground" title={path}>
            {path}
          </span>
        ),
      visible: false,
      width: "20rem",
    },
  },
});
