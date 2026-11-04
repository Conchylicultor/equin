import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { WebsiteBand } from "./website-band";

/**
 * The body of a page whose content is not written yet: one short line saying
 * so, under the page's heading.
 *
 * Every placeholder page says it the same way, which is why it is one component:
 * a reader who follows a link to an unwritten page should recognise the note,
 * not read three different apologies.
 */
export function WebsiteSoon() {
  return (
    <WebsiteBand section="soon" rhythm="page" className="text-center">
      <Stack gap="xs" align="center">
        <Text variant="eyebrow" tone="muted" className="font-semibold">
          More details soon
        </Text>
        <Text as="p" variant="body" tone="muted">
          This page is still being written.
        </Text>
      </Stack>
    </WebsiteBand>
  );
}
