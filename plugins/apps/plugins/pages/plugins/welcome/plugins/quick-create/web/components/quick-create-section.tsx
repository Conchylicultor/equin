import { Icon } from "@plugins/ui/plugins/icons/web";
import { type ReactElement } from "react";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  createPageWithSeed,
  pageDetailPane,
} from "@plugins/apps/plugins/pages/plugins/page-tree/web";
import { PAGE_TEMPLATES, type PageTemplate } from "../internal/templates";

export function QuickCreateSection(): ReactElement {
  const fetchEndpoint = useFetchEndpoint();
  const openPane = useOpenPane();

  const create = (template: PageTemplate) => {
    void (async () => {
      const id = await createPageWithSeed(fetchEndpoint, {
        parentId: null,
        page: template.page,
        seed: template.seed,
      });
      openPane(pageDetailPane, { pageId: id }, { mode: "push" });
    })();
  };

  return (
    <Stack gap="md">
      <Text as="span" variant="label" tone="muted">
        Start a new page
      </Text>
      {/* eslint-disable-next-line layout/no-adhoc-layout -- responsive col-count grid (1-up → 3-up at the sm viewport breakpoint) */}
      <div className="grid grid-cols-1 gap-md sm:grid-cols-3">
        {PAGE_TEMPLATES.map((template) => {
          const icon = template.icon;
          return (
            <Card
              key={template.id}
              as="button"
              interactive
              onClick={() => create(template)}
              className="rounded-lg p-md text-left"
            >
              <Stack gap="sm">
                <Icon icon={icon} className="size-5 text-muted-foreground" />
                <Stack gap="2xs">
                  <Text as="span" variant="body" className="font-medium">
                    {template.label}
                  </Text>
                  <Text as="span" variant="caption" tone="muted">
                    {template.description}
                  </Text>
                </Stack>
              </Stack>
            </Card>
          );
        })}
      </div>
    </Stack>
  );
}
