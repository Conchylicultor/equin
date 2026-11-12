import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useMemo, useState, type ReactElement } from "react";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Profiling } from "../slots";
import { ProfilingContext, SpanDetail } from "./shared";
import type { Span } from "./shared";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const refreshIcon = symbol("refresh");

export function GanttView(): ReactElement {
  const [hovered, setHovered] = useState<Span | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const ctxValue = useMemo(
    () => ({ hovered, setHovered, refreshKey }),
    [hovered, setHovered, refreshKey],
  );

  return (
    <ProfilingContext.Provider value={ctxValue}>
      <Column
        className="h-full"
        header={
          // eslint-disable-next-line rail/no-adhoc-band -- debt (task-1794237886-rfwccn): a Band only once the profiling pane owns its inset — today it hand-pads, so a Band here would sit on a different edge than its content
          <Line className="border-b px-lg py-sm">
            {/* Empty grow cell: it absorbs the slack so Refresh sits flush-right. */}
            <Fill />
            <Button variant="ghost" onClick={() => setRefreshKey((k) => k + 1)}>
              <Icon icon={refreshIcon} className="size-3.5" />
              Refresh
            </Button>
          </Line>
        }
        body={
          <div className="divide-y">
            <Profiling.Section.Render>
              {(section) => (
                <div key={section.id}>
                  <section.component />
                </div>
              )}
            </Profiling.Section.Render>
          </div>
        }
        footer={<SpanDetail span={hovered} />}
      />
    </ProfilingContext.Provider>
  );
}
