import {
  isolatedExhibit,
  type Exhibit,
} from "@plugins/plugin-meta/plugins/exhibits/core";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Placeholder } from "../../web";

/** Two stand-in rows: a row host's content, `Row` pills (`p-row`). */
function Rows() {
  return (
    <>
      {/* eslint-disable-next-line data-view/no-adhoc-row-list -- an exhibit's stand-in rows, not domain records */}
      {["Alpha", "Bravo"].map((label) => (
        <Row key={label}>{label}</Row>
      ))}
    </>
  );
}

// A Placeholder declares no inline inset: its text lands on the edge of the
// region it sits in — the rail in a plain region, the rows' text edge in a row
// host — level with the content around it.
export const placeholderExhibits: Exhibit[] = [
  isolatedExhibit({
    id: "placeholder/hosts",
    label: "Placeholder in a region, a row host and a padded box",
    widths: [320],
    render: () => (
      <Stack gap="lg">
        <Stack gap="none" className="rail-md rounded-md border">
          <Text variant="label">Region (rail-md)</Text>
          <Placeholder>No items yet.</Placeholder>
          <Text variant="body">Content on the rail</Text>
        </Stack>
        <Stack gap="none" className="rail-xs rail-rows rounded-md border">
          <Rows />
          <Placeholder>No more results.</Placeholder>
        </Stack>
        <Stack gap="none" className="p-md rounded-md border">
          <Text variant="label">Padded box (p-md)</Text>
          <Placeholder tone="error">Couldn&apos;t load the list.</Placeholder>
        </Stack>
      </Stack>
    ),
  }),
];
