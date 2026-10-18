import type { ReactNode } from "react";
import {
  Loading,
  type LoadingVariant,
} from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  Button,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { FilterError } from "@plugins/network/plugins/live/plugins/filter/core";
import type { BodyState } from "../internal/body-state";
import { UnavailableFilterRuleError } from "../internal/live-filter";

/**
 * What the body renders in place of the active view (`resolveBodyState`'s
 * non-view arms) — the ONE rendering of each, whichever origin produced it:
 *
 * - `server-error`: the query that could not be formed or paged, in words;
 * - `rule-error`: a saved filter / fold / sort rule the view cannot run, named,
 *   with Remove — the way out of a stale saved view (a deleted custom column,
 *   a renamed field id). It ignores the host's `errorState`, like
 *   `server-error`: a host's own failure UI would hide that way out;
 * - `error`: a failed read — the host's `errorState`, else the read's own
 *   failure with Retry (or Reload for an out-of-date tab);
 * - `field-error`: a field the view is laid out by failed to load its values
 *   — the host's `errorState`, else that failure, naming the field;
 * - `loading`: the host's `loadingState`, else the view type's skeleton.
 */
export function BodyFallback(props: {
  state: Exclude<BodyState, { kind: "view" }>;
  errorState: ReactNode | undefined;
  loadingState: ReactNode | undefined;
  loadingVariant: LoadingVariant | undefined;
  loadingCount: number | undefined;
  /** Removes the rule error's rules from the tree they sit in, and saves the view. */
  onRemoveRules: (
    error: Extract<BodyState, { kind: "rule-error" }>["error"],
  ) => void;
}): ReactNode {
  const { state } = props;
  switch (state.kind) {
    case "server-error":
      return (
        <Placeholder tone="error">
          {state.error instanceof FilterError
            ? `This filter is too large to run: ${state.error.message}`
            : `Couldn't load: ${state.error.message}`}
        </Placeholder>
      );
    case "rule-error": {
      const { error } = state;
      const count =
        error instanceof UnavailableFilterRuleError
          ? error.rules.length
          : error.fieldIds.length;
      return (
        <Center axis="horizontal">
          <Inset pad="sm">
            <Stack gap="xs" align="center">
              <Placeholder tone="error">{error.message}</Placeholder>
              <ControlSizeProvider size="sm">
                <Button
                  variant="ghost"
                  onClick={() => props.onRemoveRules(error)}
                >
                  {count === 1 ? "Remove rule" : "Remove rules"}
                </Button>
              </ControlSizeProvider>
            </Stack>
          </Inset>
        </Center>
      );
    }
    case "error":
      return (
        props.errorState ?? (
          <ResourceErrorInline
            error={state.error.error}
            refetch={state.error.refetch}
            variant="block"
          />
        )
      );
    case "field-error":
      return (
        props.errorState ?? (
          <ResourceErrorInline
            error={state.error}
            refetch={state.refetch}
            subject={state.field}
            variant="block"
          />
        )
      );
    case "loading":
      return (
        props.loadingState ?? (
          <Loading
            variant={props.loadingVariant ?? "rows"}
            count={props.loadingCount}
          />
        )
      );
  }
}
