import { setConfigField } from "@plugins/config_v2/core";
import {
  ConfigFieldAdornmentsProvider,
  ConfigFieldContext,
  FieldRenderer,
  type ConfigFieldAdornments,
} from "@plugins/config_v2/plugins/fields/web";
import type { FieldDef } from "@plugins/fields/core";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { useLiveMutation } from "@plugins/network/plugins/live/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useCallback, useMemo } from "react";

import { resetConfigField } from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const undoIcon = symbol("undo");
const warningIcon = symbol("warning");

function formatOriginValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

const TIER_BADGE = {
  git: { label: "git", className: "bg-info/10 text-info" },
  user: { label: "user", className: "bg-primary/10 text-primary-text" },
} as const;

/**
 * ONE CONFIG FIELD IN THE SETTINGS PANE — and no chrome of its own.
 *
 * It used to draw the row: a `Stack` with a `Rigid` accent bar, the renderer in a
 * `Fill`, a tier `Badge`, a hover-revealed reset `<button>` and an `Inset`
 * conflict note. Every one of those is now a prop on the panel member the FIELD
 * renders — `mark`, `status`, `actions`, `note` — so the stripe, the badge and
 * the reset land in the row's own reserved tracks instead of beside a row that
 * had already bled to the panel's edge.
 *
 * What is left is the part only this surface knows: whether the value differs
 * from its default, which tier it came from, whether upstream disagrees, and what
 * to call when the user resets or accepts. It says those things and hands them
 * down; where they are drawn is the vocabulary's answer, in `FieldShapeView`.
 */
export function ConfigField({
  fieldKey,
  field,
  value,
  storePath,
  scopeId,
  originValue,
  trueConflictKeys,
  tier,
}: {
  fieldKey: string;
  field: FieldDef;
  value: unknown;
  storePath: string;
  scopeId?: string;
  originValue?: unknown;
  trueConflictKeys?: string[];
  tier: "default" | "git" | "user";
}) {
  // MODIFIED MEANS THE USER LAYER SUPPLIED THIS VALUE — nothing is compared here.
  // The server already decided which layer each field came from (config-v2.tiers),
  // reading the propagated origin (the repo's generated origin ⊕ any committed
  // authored override) against the per-worktree override document. Diffing the
  // live value against `descriptor.defaults` instead marked every config with a
  // committed override as permanently modified, and every reorder slot always.
  const isModified = tier === "user";
  // When a three-way merge is available (trueConflictKeys present), only the
  // fields both sides changed differently are flagged — a field the user changed
  // but upstream didn't is a legitimate keep, not a conflict. Without an ancestor
  // (legacy/binary path) fall back to the naive value-vs-origin comparison.
  const hasConflict =
    trueConflictKeys !== undefined
      ? trueConflictKeys.includes(fieldKey)
      : originValue !== undefined &&
        JSON.stringify(value) !== JSON.stringify(originValue);

  // useEndpointMutation (not void fetchEndpoint) so a failed save/reset surfaces
  // via the global error toast instead of escaping as an unhandled rejection.
  const { mutate: setField } = useLiveMutation(setConfigField);
  const { mutate: resetField } = useEndpointMutation(resetConfigField);

  // The write is predicted (`setConfigField`'s effect), so `value` already
  // carries it: a second write built from the rendered value builds on the
  // first, and nothing here overlays the server's echo.
  //
  // `fromOverride`: this editor binds to the override document during a
  // conflict (`conflictEntry.overrideValues`), so its writes edit the user's
  // parked values — the one write a document in conflict accepts.
  const handleChange = useCallback(
    (newValue: unknown) => {
      setField({
        body: {
          storePath,
          key: fieldKey,
          value: newValue,
          scopeId,
          fromOverride: true,
        },
      });
    },
    [setField, storePath, fieldKey, scopeId],
  );

  const handleReset = useCallback(() => {
    resetField({ body: { storePath, key: fieldKey, scopeId } });
  }, [resetField, storePath, fieldKey, scopeId]);

  const handleAcceptOrigin = useCallback(() => {
    setField({
      body: {
        storePath,
        key: fieldKey,
        value: originValue,
        scopeId,
        fromOverride: true,
      },
    });
  }, [setField, storePath, fieldKey, originValue, scopeId]);

  const configFieldCtxValue = useMemo(
    () => ({ storePath, fieldKey }),
    [storePath, fieldKey],
  );

  const label = field.meta.label ?? fieldKey;
  const badge = tier !== "default" ? TIER_BADGE[tier] : undefined;

  // The OBJECT is always supplied, even when every entry is undefined: its
  // presence is what tells the vocabulary that this surface adorns its fields at
  // all, and the member that can hold a reset is a different member from the one
  // that cannot. Derive presence from the entries instead and a toggle would
  // change control the first time it was edited.
  const adornments: ConfigFieldAdornments = useMemo(
    () => ({
      mark: hasConflict ? "warning" : isModified ? "accent" : undefined,
      status: badge ? (
        <Badge colorClass={badge.className} className={rigidClass()}>
          {badge.label}
        </Badge>
      ) : undefined,
      // Only for a modified field: a reset offered on a field that is already at
      // its default is a button that does nothing. It is hover-revealed by the
      // row's own `RowActions`, so nothing here hides it.
      actions: isModified ? (
        <IconButton
          icon={undoIcon}
          label={`Reset ${label}`}
          onClick={handleReset}
        />
      ) : undefined,
      note: hasConflict ? (
        <Stack direction="row" gap="sm" align="center" className="text-warning">
          <Icon icon={warningIcon} className={cn("size-3", rigidClass())} />
          <Fill as="span" className="truncate">
            Upstream: {formatOriginValue(originValue)}
          </Fill>
          <Badge
            as="button"
            type="button"
            variant="warning"
            className={cn("hover:bg-warning/30", rigidClass())}
            onClick={handleAcceptOrigin}
          >
            Accept
          </Badge>
        </Stack>
      ) : undefined,
    }),
    [
      hasConflict,
      isModified,
      badge,
      label,
      handleReset,
      handleAcceptOrigin,
      originValue,
    ],
  );

  return (
    <ConfigFieldContext.Provider value={configFieldCtxValue}>
      <ConfigFieldAdornmentsProvider value={adornments}>
        <FieldRenderer field={field} value={value} onChange={handleChange} />
      </ConfigFieldAdornmentsProvider>
    </ConfigFieldContext.Provider>
  );
}
