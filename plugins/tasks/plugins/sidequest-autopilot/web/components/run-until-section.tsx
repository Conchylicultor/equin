import { useState, type ReactElement } from "react";
import { useConfigResult, useSetConfig } from "@plugins/config_v2/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  ControlPanel,
  ControlPanelPane,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Input } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { sidequestAutopilotConfig } from "../../shared/config";
import { parseRunUntil, type RunUntil } from "../../shared/run-until";

// Until a date, first offered: a day from now.
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How long it keeps starting agents: until you turn it off, or until a date
 * and time — after which it turns itself off. Agents already running finish
 * either way.
 */
export function RunUntilSection(): ReactElement {
  const config = useConfigResult(sidequestAutopilotConfig);
  switch (config.status) {
    case "loading":
      return <Loading variant="rows" />;
    case "error":
      return (
        <ResourceErrorInline
          variant="block"
          subject="its end time"
          error={config.error}
          refetch={config.refetch}
        />
      );
    case "ready":
      break;
  }
  return <RunUntilPanel runUntil={parseRunUntil(config.data.runUntil)} />;
}

function RunUntilPanel({ runUntil }: { runUntil: RunUntil }): ReactElement {
  const set = useSetConfig(sidequestAutopilotConfig);
  return (
    <ControlPanelPane label="Run until">
      <ControlPanel.Section label="Run until">
        <ControlPanel.Row
          select="radio"
          checked={runUntil.kind === "no-end"}
          onSelect={() => set("runUntil", "")}
          description="Keeps starting agents until you turn it off."
        >
          Until I turn it off
        </ControlPanel.Row>
        <ControlPanel.Row
          select="radio"
          checked={runUntil.kind === "until"}
          onSelect={() =>
            set(
              "runUntil",
              new Date(Date.now() + DEFAULT_WINDOW_MS).toISOString(),
            )
          }
          description="Turns itself off then. Agents already running finish and report."
        >
          Until a date
        </ControlPanel.Row>
        {runUntil.kind === "until" ? (
          <ControlPanel.Setting
            label="Ends"
            hint="This machine's local time."
            fit="field"
            control={
              <EndInput
                at={runUntil.at}
                onCommit={(at) => set("runUntil", at.toISOString())}
              />
            }
          />
        ) : null}
      </ControlPanel.Section>
    </ControlPanelPane>
  );
}

/** `at` as a `datetime-local` value: local wall time, to the minute. */
function toLocalInput(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** A local date and time, written once the person is done — on blur or Enter. */
function EndInput({
  at,
  onCommit,
}: {
  at: Date;
  onCommit: (at: Date) => void;
}): ReactElement {
  const value = toLocalInput(at);
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(value);
  }
  const commit = (): void => {
    if (draft === value) return;
    // `datetime-local` is local wall time with no zone: `new Date` reads it
    // as such. An incomplete value is put back rather than saved.
    const next = new Date(draft);
    if (Number.isNaN(next.getTime())) setDraft(value);
    else onCommit(next);
  };
  return (
    <Input
      type="datetime-local"
      value={draft}
      aria-label="Run until"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}
