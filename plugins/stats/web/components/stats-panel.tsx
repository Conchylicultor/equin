import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack, Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { MountWhenNear } from "@plugins/primitives/plugins/dom/plugins/in-view/web";
import { findScrollParent } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
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
                  {/* A card's charts mount only once it nears the screen: drawn
                      all at once, the ~20 charts below the fold made opening
                      Stats a 0.5–2.5 s frame, and started every card's reads. */}
                  <MountWhenNear
                    scrollRoot={findScrollParent}
                    fallback={
                      <Loading variant="block" className="h-72 w-full" />
                    }
                  >
                    <item.component />
                  </MountWhenNear>
                </Stack>
              </Surface>
            )}
          </Stats.Chart.Render>
        )}
      </Stack>
    </Inset>
  );
}
