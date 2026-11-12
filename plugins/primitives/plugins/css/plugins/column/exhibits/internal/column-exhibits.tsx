import {
  isolatedExhibit,
  regionExhibit,
  type Exhibit,
} from "@plugins/plugin-meta/plugins/exhibits/core";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Band, Column } from "../../web";

/** Three stand-in rows: a row host's content, `Row` pills (`p-row`). */
function Rows() {
  return (
    <>
      {/* eslint-disable-next-line data-view/no-adhoc-row-list -- an exhibit's three stand-in rows, not domain records */}
      {["Alpha", "Bravo", "Charlie"].map((label) => (
        <Row key={label}>{label}</Row>
      ))}
    </>
  );
}

// ── Column inset: each region a region owner ────────────────────────
//
// `Column inset` opens the header, the body's scroller and the footer each as a
// region at the step (`rail-x-<step>`, owed 0). The harness's kit is dropped in
// the BODY — the scroller's region — so it checks the two failure modes at
// once: an inheriting child must land on the step (the column stopped paying),
// and the kit's follower must add nothing (a follower region instead of an
// owner would make it pay a second time — the owe/follow topology's trap).
export const columnExhibits: Exhibit[] = [
  regionExhibit({
    id: "column/inset-region",
    label: "Column inset body region",
    widths: [288, 400],
    render: (children) => (
      <Column
        inset="sm"
        rules
        className="h-80"
        header={<Text variant="label">Header</Text>}
        body={children}
        footer={<Text variant="caption">Footer</Text>}
      />
    ),
  }),
  // A `Band` puts its text on the host's TEXT rail: in a row host (`rail-rows`,
  // a menu, `Column inset`) one row pad past the rail, level with the rows'
  // text; in a plain region, on the rail. Its rule runs edge to edge in both.
  isolatedExhibit({
    id: "column/band",
    label: "Band in a row host and in a plain region",
    widths: [288, 400],
    render: () => (
      <Stack gap="lg">
        <Stack gap="none" className="rail-xs rail-rows rounded-md border">
          <Rows />
          <Band rule="top">
            <Text variant="caption" tone="muted">
              Band — on the rows&apos; text edge
            </Text>
          </Band>
          <Rows />
        </Stack>
        <Stack gap="none" className="rail-md rounded-md border">
          <Text variant="body">Loose content on the rail</Text>
          <Band rule="both">
            <Text variant="caption" tone="muted">
              Band — on the rail
            </Text>
          </Band>
          <Text variant="body">More loose content</Text>
        </Stack>
      </Stack>
    ),
  }),
];
