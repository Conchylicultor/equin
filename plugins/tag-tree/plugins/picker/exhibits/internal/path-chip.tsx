import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { TagPathChipView } from "../../web/components/tag-path-chip";
import { FIXTURE_TAGS } from "./fixtures";

/** The header chip tagged (a deep path collapses to `first / … / leaf`), shallow, and untagged. */
export default function TagPathChipExhibit() {
  return (
    <Inline gap="sm">
      <TagPathChipView tags={FIXTURE_TAGS} tagId="app-website-home" />
      <TagPathChipView tags={FIXTURE_TAGS} tagId="app-chord" />
      <TagPathChipView tags={FIXTURE_TAGS} tagId={null} />
    </Inline>
  );
}
