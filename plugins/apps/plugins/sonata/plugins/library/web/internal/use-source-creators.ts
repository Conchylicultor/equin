import { useMemo } from "react";
import type { CreateOption } from "@plugins/primitives/plugins/data-view/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useOpenDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import { Library } from "../slots";

/** A source's creator always creates in place: the action arm of {@link CreateOption}. */
export type ActionCreateOption = Extract<CreateOption, { onSelect: unknown }>;

/**
 * Every source's create affordance as a data-view {@link CreateOption}, its
 * `onSelect` bound to this surface's fetcher and dialog opener. Source-agnostic: a source without
 * a `createOption` is skipped, and nothing here names one. Shared by the
 * library's "+" menu and the first-run onboarding cards.
 */
export function useSourceCreators(): ActionCreateOption[] {
  const sources = Library.Source.useContributions();
  const fetchEndpoint = useFetchEndpoint();
  const openDialog = useOpenDialog();
  return useMemo(
    () =>
      sources.flatMap((s) => {
        const option = s.createOption;
        if (!option) return [];
        return [
          {
            ...option,
            onSelect: () => option.onSelect({ fetchEndpoint, openDialog }),
          },
        ];
      }),
    [sources, fetchEndpoint, openDialog],
  );
}
