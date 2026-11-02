import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { Fragment } from "react";
import type { FrontmatterField } from "../internal/frontmatter";

/**
 * Renders a markdown file's YAML frontmatter as a key/value metadata card above
 * the body, instead of letting the `---` fence render as raw `<hr>` + text.
 */
export function FrontmatterCard({ fields }: { fields: FrontmatterField[] }) {
  return (
    <Inset b="lg">
      <Card
        as="dl"
        // eslint-disable-next-line layout/no-adhoc-layout -- auto/minmax(0,1fr) definition-list grid aligns the key column across all rows — cross-row column alignment a single-row Frame can't express
        className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-lg gap-y-xs"
      >
        {fields.map((field) => (
          <Fragment key={field.key}>
            <SectionLabel as="dt" className="pt-2xs">
              {field.key}
            </SectionLabel>
            <Text as="dd" variant="body" className="break-words">
              {field.value}
            </Text>
          </Fragment>
        ))}
      </Card>
    </Inset>
  );
}
