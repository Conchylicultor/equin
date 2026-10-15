import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { releaseFields } from "../../core";
import { ReleaseCell } from "../components/release-field";

// How the deployments list's `release` client field presents: the chip of the
// row's probed release info, trailing.
export const releasePresentation = FieldPresentation.Register({
  owner: releaseFields,
  fields: {
    release: {
      cell: (_state, row) => <ReleaseCell row={row} />,
      align: "end",
    },
  },
});
