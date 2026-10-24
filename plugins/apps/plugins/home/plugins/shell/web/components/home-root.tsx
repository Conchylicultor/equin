import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";

import { Home } from "../slots";

/**
 * The launcher screen (Home's index pane): a centred title block, then the sections (the app grid
 * with its capsule toolbar), in one column `min(932px, 100% − 40px)` wide —
 * seven 116px icon cells and their 16px gaps — centred in the tab.
 */
export function HomeRoot() {
  return (
    <Stack gap="none" className="relative h-full bg-background">
      <Column
        gap="none"
        className="h-full w-full"
        // The column body owns the single scroll, so the DataView's sticky
        // capsule pins to the top of the tab once the title scrolls away.
        body={
          // The container the page margin's query reads: the tab's width, not
          // the viewport's, so a narrow floating window gets the tighter margin.
          <Center axis="horizontal" className="@container/home">
            <Stack
              gap="xl"
              // eslint-disable-next-line spacing/no-adhoc-spacing -- the launcher's page margin (64px, 40px under 760px) and its column measure (seven 116px cells + 16px gaps + 24px, 20px gutters) are page geometry above the spacing ramp's largest step
              className="w-[min(932px,calc(100%-40px))] py-[64px] @max-[760px]/home:py-[40px]"
            >
              <Stack
                as="header"
                gap="sm"
                align="center"
                className="text-center"
              >
                {/* The page's one headline: the display role, which Home's
                    theme sets to the mock's 34px semibold. */}
                <Text as="h1" variant="display">
                  Apps
                </Text>
                <Text as="p" variant="body" tone="faint">
                  Open an app to get started.
                </Text>
              </Stack>
              <Home.Section.Render />
            </Stack>
          </Center>
        }
      />
    </Stack>
  );
}
