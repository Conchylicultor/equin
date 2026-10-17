import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack, Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Stats } from "../slots";
import { StatsProvider, useShowEmptyDays } from "./stats-context";

export function StatsPanel() {
  return (
    <StatsProvider>
      <StatsContent />
    </StatsProvider>
  );
}

function StatsContent() {
  const charts = Stats.Chart.useContributions();
  const { showEmptyDays, setShowEmptyDays } = useShowEmptyDays();

  return (
    <Inset pad="xl">
      <Stack gap="xl" className="mx-auto max-w-4xl">
        <Stack direction="row" gap="sm" justify="end">
          <ToggleChip as="a" href="/debug/profiling" active={false}>
            Profiling
          </ToggleChip>
          <ToggleChip
            active={showEmptyDays}
            onClick={() => setShowEmptyDays(!showEmptyDays)}
            tooltip={
              showEmptyDays
                ? "Showing all days — click to skip empty days"
                : "Skipping empty days — click to show all days"
            }
          >
            Show empty days
          </ToggleChip>
        </Stack>
        {charts.length === 0 ? (
          <Text as="div" variant="body" className="text-muted-foreground">No stats available.</Text>
        ) : (
          <Stats.Chart.Render>
            {(item) => (
              <Surface level="raised" as="section" className="p-lg">
                <Stack gap="lg">
                  <Text as="h2" variant="label">{item.title}</Text>
                  <item.component />
                </Stack>
              </Surface>
            )}
          </Stats.Chart.Render>
        )}
      </Stack>
    </Inset>
  );
}
