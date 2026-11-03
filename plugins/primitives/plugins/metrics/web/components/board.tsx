import type { ReactNode } from "react";
import {
  EditableViewSwitcher,
  useViewModel,
} from "@plugins/primitives/plugins/data-view/plugins/view-core/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { BoardSpecSchema } from "../../core";
import { BOARD_VIEW_ENTRIES, type BoardConfig } from "../internal/board-config";
import { BoardView } from "./board-view";
import { MetricError } from "./metric-error";
import type { MetricPick } from "./metric-card";

export interface BoardProps {
  /** From `defineBoardConfig` — the same handle the declaring plugin registers. */
  config: BoardConfig;
  /** A click on a chart's bucket. Default: open the drill-down drawer on it. */
  onPick?: (pick: MetricPick) => void;
}

/**
 * A tabbed board: each tab a view-core instance of the one "board" view type,
 * switched and edited with the view switcher, its `BoardSpec` authored in the
 * config document. A tab whose spec does not parse is an error card naming
 * the problem — never a partially drawn board.
 */
export function Board({ config, onPick }: BoardProps): ReactNode {
  const model = useViewModel(
    config.id,
    config.descriptors,
    BOARD_VIEW_ENTRIES,
    undefined,
  );
  if (!model.ready) {
    if (model.failure === null) return <Loading />;
    return (
      <ResourceErrorInline
        variant="block"
        error={model.failure.error}
        refetch={model.failure.refetch}
        subject="the board"
      />
    );
  }
  if (model.instances.length === 0) {
    return (
      <Text variant="caption" tone="muted">
        This board has no tabs yet.
      </Text>
    );
  }
  const view = model.viewFor(model.activeId);
  if (view === undefined) {
    throw new Error(`board "${config.id}": no view "${model.activeId}"`);
  }
  // The row's `view` is the spec plus the view-type tag the engine owns.
  const { type: _type, ...options } = view;
  const spec = BoardSpecSchema.safeParse(options);
  return (
    <Stack gap="lg">
      <EditableViewSwitcher
        instances={model.instances}
        activeId={model.activeId}
        onSelect={model.setActiveView}
        actions={model.actions}
      />
      {spec.success ? (
        <BoardView
          key={model.activeId}
          spec={spec.data}
          storageKey={config.id}
          viewId={model.activeId}
          onPick={onPick}
        />
      ) : (
        <MetricError
          title="This tab could not be read"
          message={spec.error.issues
            .map((i) => `${i.path.join(".") || "(spec)"}: ${i.message}`)
            .join("; ")}
        />
      )}
    </Stack>
  );
}
