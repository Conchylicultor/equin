import type {
  ConfigSource,
  ConfigV2ConflictLocations,
} from "@plugins/config_v2/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { WithTooltip } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { conflictSentence } from "../internal/conflict-locations";
import { useScopeDisplay } from "../internal/scope-label";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const warningIcon = symbol("warning");

/** Source → short tag label. `manual` (and missing) carries no tag — only the
 * auto-generated provenances are worth surfacing. */
const SOURCE_LABEL: Partial<Record<ConfigSource, string>> = {
  reorder: "Reorder",
  view: "View",
};

/**
 * Trailing indicator for a config row: an optional auto-generated source tag,
 * followed by a conflict warning or a modified-field count badge.
 *
 * The warning always says what it is about. A row can be flagged because its
 * base document conflicts, or because one of the apps it is customized for does
 * — and the second case used to open a detail pane on a clean Base with nothing
 * on it, so the sentence naming the scopes is the point of the icon, not
 * decoration on it.
 */
export function ConfigRowBadge({
  modifiedCount,
  conflict,
  source,
}: {
  /** `undefined` while the counts are not known yet — no count is painted. */
  modifiedCount: number | undefined;
  /** `undefined` when there is no conflict, or while that is not known yet. */
  conflict: ConfigV2ConflictLocations | undefined;
  source?: ConfigSource;
}) {
  const scopeDisplay = useScopeDisplay();
  const sourceLabel = source ? SOURCE_LABEL[source] : undefined;
  const sourceTag = sourceLabel ? (
    // eslint-disable-next-line spacing/no-adhoc-spacing -- trailing row indicator offset from the row label
    <Badge variant="muted" shape="pill" className="ml-2">
      {sourceLabel}
    </Badge>
  ) : null;

  const indicator = conflict ? (
    <WithTooltip content={conflictSentence(conflict, scopeDisplay)}>
      {/* eslint-disable-next-line spacing/no-adhoc-spacing -- trailing row indicator offset from the row label */}
      <Inline as="span" gap="none" className="ml-2 text-warning">
        <Icon icon={warningIcon} className="size-4" />
      </Inline>
    </WithTooltip>
  ) : modifiedCount !== undefined && modifiedCount > 0 ? (
    // eslint-disable-next-line spacing/no-adhoc-spacing -- trailing row indicator offset from the row label
    <Center className="ml-2 size-5 rounded-full bg-primary text-3xs font-medium text-primary-foreground">
      {modifiedCount}
    </Center>
  ) : null;

  if (!sourceTag && !indicator) return null;
  return (
    <>
      {sourceTag}
      {indicator}
    </>
  );
}
