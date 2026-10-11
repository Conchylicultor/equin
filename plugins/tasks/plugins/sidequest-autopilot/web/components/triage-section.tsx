import type { ReactElement } from "react";
import { useConfigResult, useSetConfig } from "@plugins/config_v2/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  ControlPanel,
  ControlPanelPane,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { PromptTemplateBlock } from "@plugins/tasks/plugins/automations/web";
import {
  sidequestAutopilotConfig,
  SIDEQUEST_AUTOPILOT_ID,
  TRIAGE_PROMPT_VARIABLES,
} from "../../shared/config";

const STALE_DAY_OPTIONS = ["3", "7", "14", "30"] as const;

/**
 * Triage's settings: whether Sonnet reads new sidequests at all, when a read
 * is tagged stale, and the prompt it reads them with. Triage only proposes —
 * the launch list's Approve is the only way a sidequest may launch.
 */
export function TriageSection(): ReactElement {
  const config = useConfigResult(sidequestAutopilotConfig);
  const set = useSetConfig(sidequestAutopilotConfig);
  switch (config.status) {
    case "loading":
      return <Loading variant="rows" />;
    case "error":
      return (
        <ResourceErrorInline
          variant="block"
          subject="its triage settings"
          error={config.error}
          refetch={config.refetch}
        />
      );
    case "ready":
      break;
  }
  const { triage, staleAfterDays, triagePrompt } = config.data;
  const staleOptions = STALE_DAY_OPTIONS.includes(
    String(staleAfterDays) as (typeof STALE_DAY_OPTIONS)[number],
  )
    ? STALE_DAY_OPTIONS
    : [...STALE_DAY_OPTIONS, String(staleAfterDays)];
  return (
    <ControlPanelPane label="Triage">
      <ControlPanel.Section
        label="Triage"
        description="Sonnet reads each sidequest once, read-only (it can only Read, Grep and Glob the main checkout), and proposes it in the launch list. It never approves anything."
      >
        <ControlPanel.Row
          select="switch"
          checked={triage}
          onSelect={() => set("triage", !triage)}
          description={
            triage
              ? "Reads every new sidequest, one at a time, whether or not the autopilot is on."
              : "Reads nothing new. Existing reads stay in the launch list."
          }
        >
          Triage new sidequests
        </ControlPanel.Row>
        <ControlPanel.Setting
          label="Stale after"
          hint="A read older than this — or of a task edited since — is tagged Stale. Nothing re-runs on its own: use Re-triage on the row."
          fit="field"
          control={
            <Select
              items={Object.fromEntries(
                staleOptions.map((d) => [d, `${d} days`]),
              )}
              value={String(staleAfterDays)}
              onValueChange={(v: string | null) => {
                if (v !== null) set("staleAfterDays", Number(v));
              }}
            >
              <SelectTrigger aria-label="Stale after">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {staleOptions.map((d) => (
                  <SelectItem key={d} value={d}>
                    {`${d} days`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <PromptTemplateBlock
          configName={SIDEQUEST_AUTOPILOT_ID}
          field="triagePrompt"
          label="Triage prompt"
          value={triagePrompt}
          variables={TRIAGE_PROMPT_VARIABLES}
          onSave={(next) => set("triagePrompt", next)}
        />
      </ControlPanel.Section>
    </ControlPanelPane>
  );
}
