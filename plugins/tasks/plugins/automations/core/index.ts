export {
  AutomationEntrySchema,
  AutomationSourceSchema,
  AutomationTriggerSchema,
  PromptVariableSchema,
} from "./internal/entry";
export type {
  AutomationEntry,
  AutomationSource,
  AutomationTrigger,
} from "./internal/entry";
export {
  AUTOMATION_KINDS,
  AutomationSettingsSchema,
  LAUNCH_DECISIONS,
  ORIGIN_ROLES,
  ScheduleSettingsSchema,
  SLOT_SETTLED_STATUSES,
  CADENCES,
  CADENCE_LABELS,
  PUSH_POLICIES,
  PUSH_POLICY_LABELS,
  SETTLE_MAX_WAIT_FACTOR,
  TRIGGER_KINDS,
  TRIGGER_KIND_LABELS,
  WEEKDAYS,
  WEEKDAY_LABELS,
  labeledOptions,
} from "./internal/settings";
export type {
  AutomationKind,
  AutomationSettings,
  Cadence,
  LaunchDecision,
  OriginRole,
  PushPolicy,
  ScheduleSettings,
  TriggerKind,
  Weekday,
} from "./internal/settings";
export {
  AUTOMATIONS_CONFIG_PLUGIN_ID,
  automationModelField,
  defineAutomationConfig,
  defineLaunchAutomationConfig,
  isLaunchAutomationConfig,
  MAX_LAUNCH_CONCURRENCY,
  MAX_LAUNCHES,
  readAutomationSettings,
} from "./internal/config";
export type {
  AutomationConfigDefaults,
  AutomationConfigFields,
  LaunchAutomationConfigDefaults,
  LaunchAutomationConfigFields,
} from "./internal/config";
export { cadenceCron, cadenceWords } from "./internal/cadence";
export type { CadenceCron } from "./internal/cadence";
export {
  PUSH_POLICY_TEXT,
  PUSH_POLICY_VARIABLE,
  renderPrompt,
  templateVariables,
  unknownTemplateVariables,
} from "./internal/template";
export type { PromptVariable, RenderedPrompt } from "./internal/template";
export {
  automationOrigins,
  AutomationOriginRowSchema,
  automationsCatalog,
  automationTasks,
  AutomationTaskRowSchema,
  launchDecisions,
  launchDecisionShape,
  LaunchDecisionRowSchema,
  taskOriginShape,
} from "./internal/resources";
export type {
  AutomationOriginRow,
  AutomationTaskRow,
  LaunchDecisionRow,
} from "./internal/resources";
export { automationsRoute, automationDetailRoute } from "./internal/routes";
export { decideLaunchEndpoint, MAX_DECIDED_TASKS } from "./internal/endpoints";
