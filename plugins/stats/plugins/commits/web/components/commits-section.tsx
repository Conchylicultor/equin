import { useState, type ReactNode } from "react";
import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { useCategories } from "@plugins/conversations/plugins/conversation-category/web";
import { commitsConfig } from "../../shared/config";
import { CumulativeCommitsChart } from "./cumulative-chart";
import { CommitsRateChart } from "./rate-chart";
import {
  CumulativeCommitsCategoryChart,
  CommitsRateCategoryChart,
} from "./commits-category-charts";

/**
 * One breakdown chart per configured conversation category — a conversation is
 * classified along every category, so there is no single "the" category to
 * break down by. The categories are enumerated generically; this plugin never
 * names one.
 */
function PerCategory({
  render,
}: {
  render: (categoryId: string) => ReactNode;
}) {
  const categories = useCategories();
  if (categories.length === 0) {
    return (
      <Placeholder tone="muted">
        No conversation categories configured yet.
      </Placeholder>
    );
  }
  return (
    <Stack gap="lg">
      {categories.map((category) => (
        <Stack key={category.id} gap="xs">
          <Text as="h4" variant="caption" className="text-muted-foreground">
            {category.name}
          </Text>
          {render(category.id)}
        </Stack>
      ))}
    </Stack>
  );
}

export function CommitsSection() {
  const [byCategory, setByCategory] = useState(false);
  const { filterRebases } = useConfig(commitsConfig);
  const setConfig = useSetConfig(commitsConfig);

  const toggle = () => setConfig("filterRebases", !filterRebases);

  return (
    <Stack gap="xl">
      <Cluster gap="sm" justify="end">
        <ToggleChip
          active={byCategory}
          onClick={() => setByCategory((v) => !v)}
        >
          By category
        </ToggleChip>
        <ToggleChip
          active={filterRebases}
          onClick={toggle}
          tooltip={
            filterRebases
              ? "Deduplication on: multi-commit pushes counted once — click to disable"
              : "Deduplication off: every commit counted — click to filter rebases"
          }
        >
          Filter rebases
        </ToggleChip>
      </Cluster>
      <Stack gap="md">
        <Text
          as="h3"
          variant="caption"
          className="font-medium text-muted-foreground"
        >
          Over time
        </Text>
        {byCategory ? (
          <PerCategory
            render={(categoryId) => (
              <CumulativeCommitsCategoryChart
                dedup={filterRebases}
                categoryId={categoryId}
              />
            )}
          />
        ) : (
          <CumulativeCommitsChart dedup={filterRebases} />
        )}
      </Stack>
      <Stack gap="md">
        <Text
          as="h3"
          variant="caption"
          className="font-medium text-muted-foreground"
        >
          Per period
        </Text>
        {byCategory ? (
          <PerCategory
            render={(categoryId) => (
              <CommitsRateCategoryChart
                dedup={filterRebases}
                categoryId={categoryId}
              />
            )}
          />
        ) : (
          <CommitsRateChart dedup={filterRebases} />
        )}
      </Stack>
    </Stack>
  );
}
