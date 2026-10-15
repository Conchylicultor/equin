import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";
import {
  requestConfigChanges,
  type RequestConfig,
  type RequestConfigChange,
  type RequestConfigScalarField,
} from "@plugins/conversations/plugins/transcript-watcher/core";
import { formatTokenCount } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import {
  FieldsCard,
  type FieldsCardField,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/fields-card/web";
import { modelDisplayLabel } from "@plugins/conversations/plugins/model-provider/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const tuneIcon = symbol("tune");

type ApiRequestEvent = Extract<JsonlEvent, { kind: "api-request" }>;

/** The main conversation's caller; any other `querySource` is named on the row. */
const MAIN_SOURCE = "repl_main_thread";

const FIELD_LABELS: Record<RequestConfigScalarField, string> = {
  model: "Model",
  effort: "Effort",
  thinking: "Thinking",
  maxTokens: "Max tokens",
  permissionMode: "Permission mode",
};

function scalarText(
  field: RequestConfigScalarField,
  value: string | number | undefined,
): string {
  if (value === undefined) return "default";
  if (field === "model") return modelDisplayLabel(String(value));
  if (field === "maxTokens" && typeof value === "number") {
    return formatTokenCount(value);
  }
  return String(value);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One change as a header phrase: `effort medium → high`, `+1 beta`. */
function changePhrase(change: RequestConfigChange): string {
  switch (change.field) {
    case "betas":
      return [
        change.added.length > 0 && `+${plural(change.added.length, "beta")}`,
        change.removed.length > 0 &&
          `−${plural(change.removed.length, "beta")}`,
      ]
        .filter(Boolean)
        .join(" ");
    case "shape":
      return "tools or system prompt changed";
    case "model":
      return `${scalarText("model", change.from)} → ${scalarText("model", change.to)}`;
    case "effort":
    case "thinking":
    case "maxTokens":
    case "permissionMode":
      return `${FIELD_LABELS[change.field].toLowerCase()} ${scalarText(change.field, change.from)} → ${scalarText(change.field, change.to)}`;
  }
}

function changeFields(change: RequestConfigChange): FieldsCardField[] {
  switch (change.field) {
    case "betas":
      return [
        ...(change.added.length > 0
          ? [{ key: "Betas added", value: change.added.join("\n") }]
          : []),
        ...(change.removed.length > 0
          ? [{ key: "Betas removed", value: change.removed.join("\n") }]
          : []),
      ];
    case "shape":
      return [{ key: "Tools", value: "the system prompt or tool set changed" }];
    case "model":
    case "effort":
    case "thinking":
    case "maxTokens":
    case "permissionMode":
      return [
        {
          key: FIELD_LABELS[change.field],
          value: `${scalarText(change.field, change.from)} → ${scalarText(change.field, change.to)}`,
        },
      ];
  }
}

/** The first call's settings, in the order a reader scans them. */
function configSummary(config: RequestConfig): string {
  return [
    modelDisplayLabel(config.model),
    config.effort && `effort ${config.effort}`,
    config.thinking && `${config.thinking} thinking`,
    config.permissionMode && `${config.permissionMode} mode`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function configFields(config: RequestConfig): FieldsCardField[] {
  const fields: FieldsCardField[] = [{ key: "Model", value: config.model }];
  for (const field of [
    "effort",
    "thinking",
    "maxTokens",
    "permissionMode",
  ] as const) {
    if (config[field] !== undefined) {
      fields.push({
        key: FIELD_LABELS[field],
        value: scalarText(field, config[field]),
      });
    }
  }
  if (config.betas.length > 0) {
    fields.push({
      key: `Betas (${config.betas.length})`,
      value: config.betas.join("\n"),
    });
  }
  return fields;
}

/**
 * A model API call's settings. The parser emits only a caller's first call and
 * the calls that changed something, counting the identical calls after each
 * into its `calls` (the `· N calls` note), so the first renders the settings in full
 * and every later row renders just what changed — the transcript reads as a
 * log of configuration changes, not one identical row per model call.
 */
export function ApiRequestRow({ event }: { event: JsonlEvent }) {
  const e = event as ApiRequestEvent;
  const sourceFields: FieldsCardField[] =
    e.source !== MAIN_SOURCE
      ? [{ key: "Caller", value: e.source || "unnamed" }]
      : [];
  const prefix = e.source !== MAIN_SOURCE ? `${e.source || "unnamed"} · ` : "";
  // The identical calls after this one are counted here, not rendered.
  const note = `· ${plural(e.calls, "call")}`;

  if (e.previous === null) {
    return (
      <FieldsCard
        icon={<Icon icon={tuneIcon} className="size-3.5" />}
        label="Request settings"
        note={note}
        summary={prefix + configSummary(e.config)}
        fields={[...sourceFields, ...configFields(e.config)]}
      />
    );
  }

  const changes = requestConfigChanges(e.previous, e.config);
  return (
    <FieldsCard
      icon={<Icon icon={tuneIcon} className="size-3.5" />}
      label="Request settings changed"
      note={note}
      summary={prefix + changes.map(changePhrase).join(" · ")}
      fields={[...sourceFields, ...changes.flatMap(changeFields)]}
    />
  );
}
